import { AsyncLocalStorage } from 'node:async_hooks';
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
