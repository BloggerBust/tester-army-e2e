import { AsyncLocalStorage } from 'node:async_hooks';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { SecretLedger } from '@e2e-dev/core/lib/internal/redact';
import { realmSlot } from '@e2e-dev/core/lib/internal/realm-slot';
import { claimProcessOutput, openAlternateScreen, RunnerOutput, uncaptured, writtenChunk, type OutputStream } from '../../src/run/process-output.ts';

const TOKEN = 'runner-output-token-1';

it('redacts process output when an older install already owns the output routing', () => {
  const slot = realmSlot<unknown>('e2e.process-output.routing.v1');
  const previous = slot.get(process);
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  slot.set(process, {
    scope: new AsyncLocalStorage(),
    terminal: { stdout: stdout.bind(process.stdout), stderr: stderr.bind(process.stderr) },
    dispatchers: {},
    process: undefined,
  });

  const shown: string[] = [];
  try {
    const secrets = new SecretLedger();
    secrets.register('apiToken', TOKEN);
    const claimed = claimProcessOutput(secrets);
    claimed.showThrough({ show: (_stream, text) => shown.push(text), showHanded: () => {}, end: () => {} });
    process.stdout.write(`token: ${TOKEN}\n`);
    claimed.end();
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    if (previous === undefined) {
      slot.delete(process);
    } else {
      slot.set(process, previous);
    }
  }

  expect(shown).toEqual(['token: <secret:apiToken>\n']);
});

it('holds and replays terminal output when an older install already dispatches stream writes', () => {
  const slot = realmSlot<unknown>('e2e.process-output.routing.v1');
  const previous = slot.get(process);
  const streams = [process.stdout, process.stderr].map((stream) => ({
    stream,
    write: stream.write,
    tty: Object.getOwnPropertyDescriptor(stream, 'isTTY'),
  }));

  const printed: string[] = [];
  const terminalWrite = (stream: OutputStream) => (text: string | Uint8Array, callback?: () => void): boolean => {
    printed.push(`${stream}: ${Buffer.from(text).toString()}`);
    callback?.();
    return true;
  };
  const terminal = { stdout: terminalWrite('stdout'), stderr: terminalWrite('stderr') };
  const scope = new AsyncLocalStorage<RunnerOutput | null>();
  const ledger = new SecretLedger();
  const olderOutput = new RunnerOutput(terminal, ledger);
  const dispatch = (stream: OutputStream): typeof process.stdout.write => {
    const forward = terminal[stream];
    return (chunk: string | Uint8Array, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
      const done = typeof encoding === 'function' ? encoding : callback;
      const text = writtenChunk(chunk, encoding);
      const context = scope.getStore();
      return context === null ? forward(text, done) : (context ?? olderOutput).write(stream, text, done);
    };
  };
  const dispatchers = { stdout: dispatch('stdout'), stderr: dispatch('stderr') };
  slot.set(process, { scope, terminal, dispatchers, process: olderOutput });

  try {
    process.stdout.write = dispatchers.stdout;
    process.stderr.write = dispatchers.stderr;
    for (const { stream } of streams) {
      Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
    }

    expect(() => claimProcessOutput(ledger)).not.toThrow();
    process.stdout.write('before the viewer\n');
    expect(printed).toEqual(['stdout: before the viewer\n']);

    const screen = openAlternateScreen('stdout');
    const entered = ['stdout: before the viewer\n', 'stdout: \u001b[?1049h\u001b[?25l'];
    try {
      process.stdout.write('while viewing\n');
      uncaptured(() => process.stderr.write('error while viewing\n'));
      expect([...printed]).toEqual(entered);
    } finally {
      screen.close();
    }
    expect(printed).toEqual([...entered, 'stdout: \u001b[?1049l\u001b[?25h', 'stdout: while viewing\n', 'stderr: error while viewing\n']);
  } finally {
    for (const { stream, write, tty } of streams) {
      stream.write = write;
      if (tty === undefined) {
        Reflect.deleteProperty(stream, 'isTTY');
      } else {
        Object.defineProperty(stream, 'isTTY', tty);
      }
    }
    if (previous === undefined) {
      slot.delete(process);
    } else {
      slot.set(process, previous);
    }
  }
});

function output() {
  const ledger = new SecretLedger();
  const terminal: Record<OutputStream, string[]> = { stdout: [], stderr: [] };
  const write = (stream: OutputStream) => (text: string | Uint8Array, callback?: () => void): boolean => {
    terminal[stream].push(Buffer.from(text).toString());
    callback?.();
    return true;
  };
  const out = new RunnerOutput({ stdout: write('stdout'), stderr: write('stderr') }, ledger);
  return { out, ledger, stdout: () => terminal.stdout.join(''), stderr: () => terminal.stderr.join('') };
}

/** Records terminal writes and lets tests control when they complete. */
function delayedTerminal(highWaterMark: number) {
  const chunks: string[] = [];
  let acknowledge: ((error?: Error | null) => void) | undefined;
  const stream = new Writable({
    highWaterMark,
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString());
      acknowledge = done;
    },
  });
  return { stream, write: stream.write.bind(stream), chunks, acknowledge: (error?: Error) => acknowledge!(error) };
}

describe('RunnerOutput', () => {
  it('holds what is printed during the config load and releases it redacted with the secrets the load registered', async () => {
    const { out, ledger, stdout, stderr } = output();
    await out.withholdDuring(async () => {
      out.write('stdout', `config: ${TOKEN}\n`);
      out.write('stderr', Buffer.from(`config error: ${TOKEN}\n`));
      expect(stdout() + stderr()).toBe('');
      ledger.register('apiToken', TOKEN);
    });
    expect(stdout()).toBe('config: <secret:apiToken>\n');
    expect(stderr()).toBe('config error: <secret:apiToken>\n');
  });

  it.each([
    {
      name: 'sends the whole emoji to the reporter when its UTF-8 bytes span two writes',
      before: Buffer.from([0xf0, 0x9f]),
      after: Buffer.from([0x98, 0x80]),
      terminal: '',
      viewer: '\u{1f600}',
    },
    {
      name: 'sends the whole emoji to the reporter when it spans two string writes',
      before: '\ud83d',
      after: '\ude00',
      terminal: '',
      viewer: '\u{1f600}',
    },
    {
      name: 'leaves a replacement character on the terminal when a string follows truncated bytes',
      before: Buffer.from([0xf0, 0x9f]),
      after: 'next',
      terminal: '�',
      viewer: 'next',
    },
    {
      name: 'leaves a replacement character on the terminal when ASCII bytes follow truncated bytes',
      before: Buffer.from([0xf0, 0x9f]),
      after: Buffer.from('next'),
      terminal: '�',
      viewer: 'next',
    },
    {
      name: 'keeps the replacement character on the terminal when the stream ends after an empty write',
      before: Buffer.from([0xf0, 0x9f]),
      after: '',
      terminal: '�',
      viewer: '',
    },
    {
      name: 'keeps an existing redaction marker on the terminal when the reporter attaches between its two parts',
      before: '<sec',
      after: 'ret:apiKey>',
      terminal: '<secret:apiKey>',
      viewer: '',
    },
  ])('$name', ({ before, after, terminal, viewer }) => {
    const { out, ledger, stderr } = output();

    ledger.register('apiKey', 'secret');
    ledger.register('phrase', 'a synthetic phrase');
    const shown: string[] = [];

    out.write('stderr', before);
    expect(stderr()).toBe('');

    out.showThrough({
      show(_stream, text) {
        shown.push(Buffer.from(text).toString());
      },
      showHanded() {},
      end() {},
    });
    out.write('stderr', after);
    out.end();

    expect(stderr()).toBe(terminal);
    expect(shown.join('')).toBe(viewer);
  });

  it.each([
    {
      name: 'sends the whole emoji to the reporter when the redactor would release only its first half',
      before: '\ud83d',
      secret: false,
      terminal: '',
      viewer: '\u{1f600}',
    },
    {
      name: 'keeps the redaction marker on the terminal when a secret ends with the first half of an emoji',
      before: 'abcdef\ud83d',
      secret: true,
      terminal: '<secret:edge>',
      viewer: '�',
    },
  ])('$name', ({ before, secret, terminal, viewer }) => {
    const { out, ledger, stderr } = output();

    ledger.register('phrase', 'synthetic phrase');
    if (secret) ledger.register('edge', before);
    // Pad the second write so the cutoff would fall between the two halves of the emoji.
    const filler = 'x'.repeat(ledger.maxFormLength - 2);
    const shown: string[] = [];

    out.write('stderr', before);
    expect(stderr()).toBe('');

    out.showThrough({
      show(_stream, text) {
        shown.push(Buffer.from(text).toString());
      },
      showHanded() {},
      end() {},
    });
    out.write('stderr', '\ude00' + filler);
    out.end();

    expect(stderr()).toBe(terminal);
    expect(shown.join('')).toBe(viewer + filler);
  });

  it.each([
    { outcome: 'success', highWaterMark: 1, accepted: false, failure: undefined },
    { outcome: 'failure', highWaterMark: 1, accepted: false, failure: new Error('terminal write failed') },
    { outcome: 'success', highWaterMark: 1024, accepted: true, failure: undefined },
    { outcome: 'failure', highWaterMark: 1024, accepted: true, failure: new Error('terminal write failed') },
  ])(
    'calls back once when the terminal finishes a write shared with the reporter ($outcome, highWaterMark $highWaterMark)',
    async ({ highWaterMark, accepted, failure }) => {
      const terminal = delayedTerminal(highWaterMark);

      const ledger = new SecretLedger();
      const out = new RunnerOutput({ stdout: terminal.write, stderr: terminal.write }, ledger);
      ledger.register('phrase', 'a synthetic phrase');

      if (failure) terminal.stream.once('error', () => {});
      const live = `live\n${'x'.repeat(256)}`;
      const shown: string[] = [];
      const completions: (Error | undefined)[] = [];

      out.write('stderr', 'config ');
      out.showThrough({
        show(_stream, text) {
          shown.push(text);
        },
        showHanded() {},
        end() {},
      });
      expect(terminal.chunks.join('')).toBe('');

      const returned = out.write('stderr', live, (error?: Error | null) => {
        completions.push(error ?? undefined);
      });
      await new Promise<void>((resolve) => process.nextTick(resolve));

      expect(returned).toBe(accepted);
      expect(terminal.chunks.join('')).toBe('config ');
      expect(completions).toEqual([]);

      terminal.acknowledge(failure);
      await new Promise<void>((resolve) => process.nextTick(resolve));

      expect(completions).toEqual([failure]);

      out.end();

      expect(terminal.chunks.join('')).toBe('config ');
      expect(shown.join('')).toBe(live);
    },
  );

  it('releases pending output in stream order across a config load', async () => {
    const { out, ledger, stdout } = output();
    ledger.register('token', 'a synthetic phrase');
    out.write('stdout', 'before ');
    await out.withholdDuring(async () => { out.write('stdout', 'config '); });
    out.write('stdout', 'after');
    out.end();
    expect(stdout()).toBe('before config after');
  });

  it.each([
    { name: 'split UTF-8 character', config: Buffer.from([0xc3]), runtime: Buffer.from([0xa9]), expected: 'é' },
    { name: 'buffered ASCII diagnostic', config: 'Loading the project config.', runtime: '!', expected: 'L' },
  ])('waits for the terminal when a runtime write releases only a $name', async ({ config, runtime, expected }) => {
    const terminal = delayedTerminal(1);
    const ledger = new SecretLedger(typeof config === 'string' ? [['token', 'synthetic phrase']] : []);
    const out = new RunnerOutput({ stdout: terminal.write, stderr: terminal.write }, ledger);
    await out.withholdDuring(async () => { out.write('stderr', config); });
    expect(terminal.chunks).toEqual([]);
    let calls = 0;
    const accepted = out.write('stderr', runtime, () => { calls++; });
    await new Promise<void>((resolve) => process.nextTick(resolve));
    expect(terminal.chunks).toEqual([expected]);
    expect({ accepted, calls }).toEqual({ accepted: false, calls: 0 });
    terminal.acknowledge();
    expect(calls).toBe(1);
    out.end();
  });

  it('keeps runtime output in order when the reporter triggers a warning during delivery', async () => {
    const { out, ledger, stderr } = output();
    ledger.register('token', 'a synthetic phrase');
    out.write('stderr', 'before ');
    await out.withholdDuring(async () => { out.write('stderr', 'config '); });
    const live: string[] = [];
    const writer = new AsyncLocalStorage<string>();
    const callbacks: (string | undefined)[] = [];
    let accepted: boolean | undefined;
    out.showThrough({
      show(_stream, text) {
        live.push(text);
        if (live.length === 1) {
          accepted = writer.run('reporter', () =>
            out.captured(() => out.write('stderr', 'warning\n', () => callbacks.push(writer.getStore()))),
          );
        }
      },
      showHanded() {},
      end() {},
    });
    const after = 'after\n' + 'x'.repeat(64);
    out.write('stderr', after);
    out.end();
    expect(accepted).toBe(true);
    expect(callbacks).toEqual([]);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    expect(callbacks).toEqual(['reporter']);
    expect(stderr()).toBe('before config ');
    expect(live.join('')).toBe(after + 'warning\n');
  });

  it('withholds what was printed while a config failed to load, and passes what follows', async () => {
    const { out, stdout, stderr } = output();
    await expect(
      out.withholdDuring(async () => {
        out.write('stdout', `broken: ${TOKEN}\n`);
        throw new Error('config refuses to load');
      }),
    ).rejects.toThrow('config refuses to load');
    expect(stdout()).toBe('');
    expect(stderr()).toBe(
      `e2e: [warning] withheld ${Buffer.byteLength(`broken: ${TOKEN}\n`)} bytes of output printed while the config failed to load: its secrets are unknown, so the output cannot be redacted\n`,
    );
    out.write('stdout', 'after the load\n');
    expect(stdout()).toBe('after the load\n');
  });

  it('redacts a value split across writes, and releases an unfinished line at the end', () => {
    const { out, ledger, stdout } = output();
    ledger.register('apiToken', TOKEN);
    out.write('stdout', `split: ${TOKEN.slice(0, 8)}`);
    out.write('stdout', `${TOKEN.slice(8)}\nno newline: ${TOKEN}`);
    expect(stdout()).toBe('split: <secret:apiToken>\n');
    out.end();
    expect(stdout()).toBe('split: <secret:apiToken>\nno newline: <secret:apiToken>');
  });

  it('shows output through a view while one is attached, releases its unfinished lines to it on detach, and fires every callback', async () => {
    const { out, ledger, stdout } = output();
    ledger.register('apiToken', TOKEN);
    const shown: string[] = [];
    out.showThrough({
      show: (stream, text) => shown.push(`${stream}:${text}`),
      showHanded: (stream, text) => shown.push(`handed ${stream}:${text}`),
      end: () => shown.push('end'),
    });
    let called = 0;
    out.write('stderr', `reporter: ${TOKEN}\n`, () => (called += 1));
    out.write('stdout', `unfinished ${TOKEN}`, () => (called += 1));
    out.printLine('a line of the runner');
    // What a reporter prints while it is handed output goes to the view apart, never the terminal.
    out.passThrough(() => out.write('stdout', `handed ${TOKEN}\n`, () => (called += 1)));
    out.showThrough(undefined);
    out.write('stdout', 'after\n', () => (called += 1));
    await new Promise((resolve) => process.nextTick(resolve));
    expect(shown).toEqual([
      'stderr:reporter: <secret:apiToken>\n',
      'stdout:a line of the runner\n',
      'handed stdout:handed <secret:apiToken>\n',
      'stdout:unfinished <secret:apiToken>',
      'end',
    ]);
    expect(stdout()).toBe('after\n');
    expect(called).toBe(4);
  });
});
