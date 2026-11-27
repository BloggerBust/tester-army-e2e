/**
 * What user code in an `e2e run` process prints outside a test body: the
 * config's top-level code, a test file's top level while it is collected,
 * test filters, and reporters in the runner; the config's top-level code
 * again in each worker. It is redacted with every secret value the process
 * knows, as a test's output is. Until a config has loaded its secrets are
 * unknown, so what is printed meanwhile is held, and withheld if the load
 * fails.
 */

import { StreamRedactor, type SecretLedger, type StreamBoundary } from '@e2e-dev/core/lib/internal/redact';
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { writeSync } from 'node:fs';
import { realmSlot } from '@e2e-dev/core/lib/internal/realm-slot';
import { inHeldTestToolCall } from './worker/held-test-tool-scope.ts';

/** Called when a write completes */
type WriteCallback = (error?: Error | null) => void;

export type OutputStream = 'stdout' | 'stderr';

/** Writes text to one stream of the terminal; the callback fires once the stream took it. Answers false while the stream is backed up, like `Writable.write`. */
export type TerminalWrite = (text: string | Uint8Array, callback?: () => void) => boolean;

type BufferedWrite = {
  readonly stream: OutputStream;
  readonly text: string | Uint8Array;
};

type AlternateScreen = {
  readonly write: TerminalWrite;
  readonly close: () => void;
};

/** What a stream `write` was handed: a string with an encoding as the bytes Node writes for it; any other chunk as is. */
export function writtenChunk(chunk: string | Uint8Array, encoding: unknown): string | Uint8Array {
  return typeof chunk === 'string' && typeof encoding === 'string' && Buffer.isEncoding(encoding) ? Buffer.from(chunk, encoding) : chunk;
}

interface OutputRouting {
  readonly scope: AsyncLocalStorage<RunnerOutput | null>;
  readonly terminal: Record<OutputStream, TerminalWrite>;
  direct?: Record<OutputStream, TerminalWrite>;
  readonly dispatchers: Partial<Record<OutputStream, typeof process.stdout.write>>;
  process: RunnerOutput | undefined;
  held?: BufferedWrite[] | undefined;
}

const routingSlot = realmSlot<OutputRouting>('e2e.process-output.routing.v1');

/** One process dispatcher preserves redaction for asynchronous work that outlives a suite. */
function routing() {
  const streams = { stdout: process.stdout, stderr: process.stderr } as const;
  let state = routingSlot.get(process);
  if (state === undefined) {
    state = {
      scope: new AsyncLocalStorage(),
      terminal: {
        stdout: streams.stdout.write.bind(streams.stdout),
        stderr: streams.stderr.write.bind(streams.stderr),
      },
      dispatchers: {},
      process: undefined,
    };
    routingSlot.set(process, state);
  }

  const upgrading = state.direct === undefined;
  const direct = state.direct ??= { ...state.terminal };

  for (const name of ['stdout', 'stderr'] as const) {
    const installed = streams[name].write === state.dispatchers[name];
    if (installed && !upgrading) continue;

    const forward = streams[name].write.bind(streams[name]) as (chunk: string | Uint8Array, encoding?: BufferEncoding | (() => void), callback?: () => void) => boolean;

    // An older dispatcher ignores the viewer. Replace it in the shared slot,
    // but keep its terminal writer so the viewer can reach the underlying stream.
    if (!installed) {
      direct[name] = (text, callback) => {
        const done = callback === undefined ? undefined : AsyncResource.bind(callback);
        return state.scope.run(null, () => forward(text, done));
      };
    }

    state.terminal[name] = (text, callback) => {
      if (state.held === undefined || streams[name].isTTY !== true) {
        return direct[name](text, callback);
      }

      state.held.push({ stream: name, text: typeof text === 'string' ? text : Buffer.from(text) });
      if (callback !== undefined) {
        process.nextTick(callback);
      }
      return true;
    };
    const dispatch = ((chunk: string | Uint8Array, encoding?: BufferEncoding | (() => void), callback?: () => void): boolean => {
      const done = typeof encoding === 'function' ? encoding : callback;

      if (inHeldTestToolCall()) {
        if (done !== undefined) {
          process.nextTick(done);
        }

        return true;
      }

      const context = state.scope.getStore();
      const output = context === null ? undefined : context ?? state.process;
      if (output === undefined && (state.held === undefined || streams[name].isTTY !== true)) return forward(chunk, encoding, callback);
      const text = writtenChunk(chunk, encoding);
      return output === undefined ? state.terminal[name](text, done) : output.write(name, text, done);
    }) as typeof process.stdout.write;
    state.dispatchers[name] = dispatch;
    streams[name].write = dispatch;
  }

  return { state, direct };
}

/** Opens the viewer's alternate screen. Buffered terminal writes are replayed in order after the screen is restored. */
export function openAlternateScreen(stream: OutputStream): AlternateScreen {
  const { state, direct } = routing();
  const write = direct[stream];
  const held: BufferedWrite[] = [];
  const leave = '\u001b[?1049l\u001b[?25h';
  const restore = (): void => {
    writeSync(process[stream].fd, leave);
  };
  const close = (): void => {
    write(leave);
    state.held = undefined;
    process.off('exit', restore);

    for (const { stream: destination, text } of held) {
      direct[destination](text);
    }
  };

  state.held = held;
  process.once('exit', restore);
  write('\u001b[?1049h\u001b[?25l');

  return { write, close };
}

/** The CLI owns every process write, including timers that print after a run ends. */
export function claimProcessOutput(ledger: SecretLedger): RunnerOutput {
  const { state } = routing();
  state.process ??= new RunnerOutput(state.terminal, ledger);
  return state.process;
}

/** Embedded runs own their async output; caller output resumes once cleanup ends. */
export async function withProcessOutput<T>(ledger: SecretLedger, run: (output: RunnerOutput) => Promise<T>): Promise<T> {
  const { state } = routing();
  const output = new RunnerOutput(state.terminal, ledger);
  try {
    return await state.scope.run(output, () => run(output));
  } finally {
    output.end();
  }
}

/** Writes the runner's own text straight to the terminal's `stream`, past the routing of user output. */
export function writeTerminal(stream: OutputStream, text: string): void {
  const terminal = routingSlot.get(process)?.terminal;
  if (terminal === undefined) process[stream].write(text);
  else terminal[stream](text);
}

/**
 * Runs `hook`, an interactive reporter showing a run that claimed no process
 * output, past the routing of user output another run in the process set
 * up: what it writes reaches the terminal as written.
 */
export function uncaptured<T>(hook: () => T): T {
  const state = routingSlot.get(process);
  return state === undefined ? hook() : state.scope.run(null, hook);
}

/** Where runner output goes instead of the terminal while a run hands it to its reporters. */
export interface OutputView {
  /** Prints redacted text from `stream`. */
  show(stream: OutputStream, text: string): void;
  /** Prints redacted text a reporter wrote while it was handed output, which must not be handed back to it. */
  showHanded(stream: OutputStream, text: string): void;
  /** Prints what `show` left unfinished; nothing more follows. */
  end(): void;
}

/** The warning that stands in for what a config printed before it failed to load. */
function withheldWarning(bytes: number): string {
  return `withheld ${bytes} bytes of output printed while the config failed to load: its secrets are unknown, so the output cannot be redacted`;
}

/**
 * Holds what is written while a config loads. Released once the load
 * registered the config's secrets; dropped for a warning when it failed.
 */
export class ConfigLoadHold {
  private held: { readonly stream: OutputStream; readonly chunk: string | Uint8Array }[] | undefined;

  /** Holds `chunk` if a load is in flight; answers whether it did. */
  hold(stream: OutputStream, chunk: string | Uint8Array): boolean {
    if (this.held === undefined) return false;
    // A copy: the writer may reuse its buffer once the write returns.
    this.held.push({ stream, chunk: typeof chunk === 'string' ? chunk : Buffer.from(chunk) });
    return true;
  }

  /**
   * Runs `load`, which loads a config and registers its secrets, holding
   * what is written meanwhile. Then hands each held write to `release` in
   * order, or, if `load` threw, `warn`s with how much was withheld.
   */
  async during<T>(
    load: () => Promise<T>,
    release: (stream: OutputStream, chunk: string | Uint8Array) => void,
    warn: (line: string) => void,
  ): Promise<T> {
    this.held = [];
    let loaded = false;
    try {
      const value = await load();
      loaded = true;
      return value;
    } finally {
      const held = this.held;
      this.held = undefined;
      if (loaded) {
        for (const { stream, chunk } of held) release(stream, chunk);
      } else {
        const bytes = held.reduce((total, { chunk }) => total + Buffer.byteLength(chunk), 0);
        if (bytes > 0) warn(withheldWarning(bytes));
      }
    }
  }
}

/**
 * The runner process's user output, on its way to the terminal or, while
 * the list reporter shows it, through the reporter, which prints it above
 * its live window instead of letting it land inside.
 */
export class RunnerOutput {
  /** Each stream redacted on its own, across writes: a value split over two writes is still caught. */
  private readonly redactors: Readonly<Record<OutputStream, StreamRedactor>>;
  /** The same for what is written inside `passThrough`, kept apart so it never waits behind, or completes, what the view holds. */
  private readonly passRedactors: Readonly<Record<OutputStream, StreamRedactor>>;
  /** The same for what is written inside `asPrinted`, which lands on other streams. */
  private readonly printRedactors: Readonly<Record<OutputStream, StreamRedactor>>;
  private readonly loadHold = new ConfigLoadHold();
  private view: OutputView | undefined;
  private viewBoundaries: Partial<Record<OutputStream, StreamBoundary>> = {};
  /** How the writes of an async context reach the terminal, past the config hold and the view: see `passThrough`, `asWritten`, and `asDocument`. */
  private readonly passing = new AsyncLocalStorage<'redacted' | 'printed' | 'written' | 'document' | false>();
  /** The terminal stream user stdout lands on: stderr once a run left stdout to its reporters. */
  private stdoutTo: OutputStream = 'stdout';
  /** The same for an interactive reporter's stdout: stderr once a run reserved stdout for its document. */
  private viewStdoutTo: OutputStream = 'stdout';
  constructor(
    private readonly terminal: Readonly<Record<OutputStream, TerminalWrite>>,
    ledger: SecretLedger,
  ) {
    this.redactors = { stdout: new StreamRedactor(ledger), stderr: new StreamRedactor(ledger) };
    this.passRedactors = { stdout: new StreamRedactor(ledger), stderr: new StreamRedactor(ledger) };
    this.printRedactors = { stdout: new StreamRedactor(ledger), stderr: new StreamRedactor(ledger) };
  }

  /**
   * One write of user code to `stream`, redacted: the tail a later write
   * could complete into a value waits for it, or for `end`. Held while a
   * config loads. Answers what the terminal did.
   */
  write(stream: OutputStream, chunk: string | Uint8Array, callback?: WriteCallback): boolean {
    const passing = this.passing.getStore();
    if (passing === 'redacted') return this.handed(stream, this.passRedactors[stream].push(chunk), callback);
    if (passing === 'printed') return this.reporterPrint(stream, this.printRedactors[stream].push(chunk), callback);
    if (passing === 'document') return this.terminal[stream](chunk, callback);
    if (passing === 'written') return this.reporterPrint(stream, chunk, callback);
    if (this.loadHold.hold(stream, chunk)) {
      if (callback !== undefined) process.nextTick(callback);
      return true;
    }
    return this.send(stream, chunk, callback);
  }

  /**
   * Redacts and routes output to the terminal or reporter and flushes the redactor
   * if no chunk is provided.
   */
  private send(stream: OutputStream, chunk?: string | Uint8Array, done?: WriteCallback): boolean {
    const cursor = this.viewBoundaries[stream];
    const redactor = this.redactors[stream];
    const text = chunk === undefined ? redactor.flush(cursor) : redactor.push(chunk, cursor);
    const prefixLength = cursor?.outputPrefixLength ?? 0;
    if (cursor?.pendingInputLength === 0) delete this.viewBoundaries[stream];
    if (prefixLength === 0) return this.emit(stream, text, done);
    const drained = this.toTerminal(stream, text.slice(0, prefixLength), done);
    if (prefixLength < text.length) this.emit(stream, text.slice(prefixLength));
    return drained;
  }

  /**
   * Runs `load`, a config load that registers the config's secrets, holding
   * what is printed until it ends: the config's top-level code may print a
   * value before the process knows it is one. Released redacted once it
   * loaded; withheld with a warning when it failed.
   */
  withholdDuring<T>(load: () => Promise<T>): Promise<T> {
    return this.loadHold.during(
      load,
      (stream, chunk) => this.write(stream, chunk),
      (line) => this.emit('stderr', `e2e: [warning] ${line}\n`),
    );
  }

  /**
   * Passes what is printed to `view` from now on, or to the terminal again
   * when undefined. What the previous view was given is released to it
   * first, unfinished lines included, and that view ended.
   */
  showThrough(view: OutputView | undefined): void {
    if (this.view !== undefined) {
      this.release();
      this.view.end();
    }
    this.view = view;
    this.viewBoundaries = view === undefined ? {} : { stdout: { outputPrefixLength: 0 }, stderr: { outputPrefixLength: 0 } };
  }

  /**
   * Runs `hook`, a reporter being handed output, so that what it writes,
   * and what the work it starts writes, even after the run or in the next
   * `--watch` run, is redacted and shown past the config hold: by the
   * view's `showHanded`, which never hands it back to the reporter, or on
   * the terminal without a view.
   */
  passThrough<T>(hook: () => T): T {
    return this.passing.run('redacted', hook);
  }

  /**
   * Runs `hook`, an interactive reporter showing the run, so that what it
   * writes, and what the timers it starts write, reaches the terminal as
   * written: it prints what the runner already redacted. Its stdout is on
   * stderr once the run reserved stdout.
   */
  asWritten<T>(hook: () => T): T {
    return this.passing.run('written', hook);
  }

  /**
   * Runs `hook`, a reporter printing its summary, so that what it writes
   * reaches the terminal redacted, on the stream it wrote to: a reporter of
   * your own can print a document to stdout. On stderr once the run
   * reserved stdout.
   */
  asPrinted<T>(hook: () => T): T {
    return this.passing.run('printed', hook);
  }

  /** Runs `hook`, the reporter that prints the run's document, so that what it writes to stdout is the only thing there. */
  asDocument<T>(hook: () => T): T {
    return this.passing.run('document', hook);
  }

  /** Runs `hook`, the runner's own write inside `passThrough`, captured and redacted like any other. */
  captured<T>(hook: () => T): T {
    return this.passing.run(false, hook);
  }

  /** Prints what user code writes to stdout on stderr from now on: during a run stdout holds only what a reporter prints there. */
  leaveStdout(): void {
    this.stdoutTo = 'stderr';
  }

  /** Leaves stdout to the run's document (`--reporter json`): from now on only `asDocument` writes there, and every other reporter's stdout is on stderr too. */
  reserveStdout(): void {
    this.stdoutTo = 'stderr';
    this.viewStdoutTo = 'stderr';
  }

  /** Whether the run reserved stdout for its document. */
  get stdoutReserved(): boolean {
    return this.viewStdoutTo === 'stderr';
  }

  /**
   * Prints a line of the runner's own, such as a pause without a terminal,
   * as its other output: to the reporters as an `output` event, which an
   * interactive one shows under `runner`, or to the terminal, on stderr
   * during a run.
   */
  printLine(line: string): void {
    this.emit('stdout', `${line}\n`);
  }

  /**
   * Prints already redacted output to the terminal, past the view: the
   * runner handed it to the reporters itself, and none shows it.
   */
  print(stream: OutputStream, text: string): void {
    this.toTerminal(stream, text);
  }

  /** Releases what is still held, redacted, to the terminal. Later writes stay redacted; only a tail a later write could complete into a value is held. */
  end(): void {
    this.showThrough(undefined);
    this.release();
  }

  /**
   * Ends the output as `end` does, then resolves once the terminal's streams
   * wrote everything handed to them: what a process waits for before
   * `process.exit`, which drops what a piped stream still queues. A `write`
   * through the claimed stream would not wait: its callback fires once the
   * text is redacted.
   */
  async drain(): Promise<void> {
    this.end();
    await Promise.all((['stdout', 'stderr'] as const).map((stream) => new Promise<void>((resolve) => void this.terminal[stream]('', resolve))));
  }

  private release(): void {
    this.send('stdout');
    this.send('stderr');
    this.handed('stdout', this.passRedactors.stdout.flush());
    this.handed('stderr', this.passRedactors.stderr.flush());
    this.reporterPrint('stdout', this.printRedactors.stdout.flush());
    this.reporterPrint('stderr', this.printRedactors.stderr.flush());
  }

  /** Writes what a reporter prints to the terminal, its stdout on stderr once the run reserved stdout. */
  private reporterPrint(stream: OutputStream, chunk: string | Uint8Array, callback?: () => void): boolean {
    if (chunk.length > 0) return this.terminal[stream === 'stdout' ? this.viewStdoutTo : stream](chunk, callback);
    if (callback !== undefined) process.nextTick(callback);
    return true;
  }

  /** Writes redacted text to the terminal; nothing to write still calls back. */
  private toTerminal(stream: OutputStream, text: string, callback?: () => void): boolean {
    if (text !== '') return this.terminal[stream === 'stdout' ? this.stdoutTo : stream](text, callback);
    if (callback !== undefined) process.nextTick(callback);
    return true;
  }

  /** Shows what a reporter wrote while it was handed output: through the view, or on the terminal without one. */
  private handed(stream: OutputStream, text: string, callback?: () => void): boolean {
    if (text === '' || this.view === undefined) return this.toTerminal(stream, text, callback);
    this.view.showHanded(stream, text);
    if (callback !== undefined) process.nextTick(callback);
    return true;
  }

  private emit(stream: OutputStream, text: string, callback?: () => void): boolean {
    if (text === '' || this.view !== undefined) {
      if (text !== '') this.view?.show(stream, text);
      if (callback !== undefined) process.nextTick(callback);
      return true;
    }
    return this.toTerminal(stream, text, callback);
  }
}
