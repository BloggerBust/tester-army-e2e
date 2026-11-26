/**
 * What `run_code` puts between its code and the objects a test body gets:
 * each object is wrapped so that a call on it runs on the real one and is
 * written down as the test line that repeats it. A call that returns at once,
 * such as a locator query, is a step in a chain; a call that returns a
 * promise is a line, and what it settled with is its outcome.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { classifyError, type E2EError } from '@e2e-dev/core/lib/internal/errors';
import { isPlainObject } from '@e2e-dev/core/lib/internal/options';

/** What became of one line: the value it resolved with, or the error it failed with. */
export type Outcome = { readonly source: string; readonly read: boolean; readonly value: unknown } | { readonly source: string; readonly error: E2EError };

/** What ended the code's turn: it settled on its own, or a timeout or a cancel cut it off. */
type Turn = 'running' | 'settled' | 'cut';

/** How long a call that was cut off waits for the operation it was in the middle of, which was cancelled with it. */
const CUT_GRACE_MS = 2_000;
// A line made while another still runs was not written after it: a test that awaits them in turn would wait on the first alone.
const ALONGSIDE = ' // ran while the line above was still running; a test needs them in one Promise.all';
const CALLBACK = ' // the function brings none of the variables run_code declared: declare the ones it uses';
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const MAX_DEPTH = 50;

/**
 * The promise of one line. `await`, `then`, `catch`, and `finally` all reach
 * `then`, so a line whose `then` nobody called is one the code never waited
 * on: its failure reached nothing in the code.
 */
class Line<T> extends Promise<T> {
  seen = false;

  // What `then` derives is an ordinary promise, not another line.
  static override get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  // oxlint-disable-next-line unicorn/no-thenable -- a Promise's own `then`, overridden to see who waits
  override then<A = T, B = never>(onValue?: ((value: T) => A | PromiseLike<A>) | null, onError?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    this.seen = true;
    return super.then(onValue, onError);
  }
}

/**
 * What a call answers once the code was cut off: every member and call gives
 * it back, and awaiting it never ends. Code still running, such as a loop
 * that catches each failure and tries again, stops at its next await with
 * nothing to catch, where an error it swallowed would spin the process.
 */
const PARKED: unknown = new Proxy(() => undefined, {
  get: (_, key) => (key === 'then' ? () => undefined : typeof key === 'symbol' ? undefined : PARKED),
  apply: () => PARKED,
});

interface Sent {
  readonly line: Line<unknown>;
  settled: Promise<unknown>;
  failed: { readonly cause: unknown } | undefined;
}

/** What a line resolves with when its failure was kept for later, as a soft assertion's is: the line failed, and the code goes on. */
export class KeptFailure {
  constructor(readonly cause: unknown) {}
}

/** Set while the server runs a function of the code: what that calls is the function's doing, already written in its line. */
const insideFunction = new AsyncLocalStorage<true>();

export class Recorder {
  /** One entry per line, in the order the code made them; a line still running holds its place. */
  private readonly slots: (Outcome | undefined)[] = [];
  private readonly reals = new WeakMap<object, object>();
  private readonly proxies = new WeakMap<object, object>();
  /** The test-line text of an object a get or a call gave the code. */
  private readonly sources = new WeakMap<object, string>();
  /** Each function of the code as the real objects hold it. */
  private readonly handlers = new WeakMap<object, object>();
  /** The functions of the code a line was written with, and the ones an engine took as text. */
  private readonly functions: object[] = [];
  private readonly sentAsText = new WeakSet<object>();
  private readonly sent: Sent[] = [];
  private readonly pending = new Set<Sent>();
  private turn: Turn = 'running';

  constructor(
    /** The secret ledger, for a string before it is escaped into a line, where the ledger would no longer know it. */
    private readonly redact: (text: string) => string,
    /** The next number for a name, counted by the session so two calls never declare the same one. */
    private readonly nextHandle: () => number,
    /** How a test writes a string it does not spell out, such as a credential's username; a string has no identity, so it is known by its value. */
    private readonly named: (text: string) => string | undefined = () => undefined,
  ) {}

  /** The roots whose calls that give a value back only read: the test API's own. An engine's fixture may act and answer at once. */
  private readonly reading = new Set<string>();

  /** What became of each line that settled, in the order the code made them. */
  get outcomes(): readonly Outcome[] {
    return this.slots.filter((slot) => slot !== undefined);
  }

  /** `real` as the code holds it: every call on it runs on `real` and is recorded under `text`. */
  wrap<T extends object>(real: T, text: string, reads = false): T {
    if (reads) this.reading.add(text);
    const known = this.proxies.get(real);
    if (known !== undefined) return known as T;
    // Not `real` itself: a frozen fixture's members could not be answered with their wrappers.
    const proxy = new Proxy(typeof real === 'function' ? () => undefined : {}, {
      get: (_, key) => (typeof key === 'symbol' ? own(real, key) : this.member(real, key, memberText(text, key))),
      apply: (_, __, args: unknown[]) => this.call(real, undefined, text, args),
      set: (_, key, value) => Reflect.set(real, key, value, real),
      has: (_, key) => Reflect.has(real, key),
      ownKeys: () => Reflect.ownKeys(real),
      getOwnPropertyDescriptor: (_, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(real, key);
        return descriptor === undefined ? undefined : { ...descriptor, configurable: true };
      },
      getPrototypeOf: () => Reflect.getPrototypeOf(real),
    });
    this.reals.set(proxy, real);
    this.proxies.set(real, proxy);
    this.sources.set(proxy, text);
    return proxy as T;
  }

  /** The test-line text of something the code holds wrapped, for a result that would otherwise print the real object's insides. */
  textOf(value: unknown): string | undefined {
    return (typeof value === 'object' || typeof value === 'function') && value !== null && this.reals.has(value) ? this.sources.get(value) : undefined;
  }

  /**
   * Ends the code's turn and waits for the lines still running, so the app is
   * where they left it. Once `cut` is aborted, by a timeout or a cancel, the
   * code never runs another call, and an operation that does not end with the
   * abort is left behind after a moment, so the session is not held for it.
   * Code that settled may have left a handler behind, such as a route's, and
   * what that calls later runs as it does in a test, unrecorded. Answers the
   * first failure nothing in the code was there to catch.
   */
  async end(cut: AbortSignal): Promise<{ readonly unawaited: number; readonly lost: { readonly cause: unknown } | undefined }> {
    this.turn = cut.aborted ? 'cut' : 'settled';
    const unawaited = [...this.pending].filter((sent) => !sent.line.seen).length;
    const settled = (async (): Promise<void> => {
      while (this.pending.size > 0) await Promise.all([...this.pending].map((sent) => sent.settled));
    })();
    const aborted = new Promise<void>((resolve) => {
      if (cut.aborted) resolve();
      else cut.addEventListener('abort', () => void resolve(), { once: true });
    });
    await Promise.race([settled, aborted]);
    if (this.pending.size > 0) {
      this.turn = 'cut';
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([settled, new Promise((resolve) => void (timer = setTimeout(resolve, CUT_GRACE_MS)))]);
      clearTimeout(timer);
    }
    // A line the code waited on gave its failure to the code, which may have chosen to go on, as the loser of a race does.
    const lost = this.sent.find((sent) => sent.failed !== undefined && !sent.line.seen);
    return { unawaited, lost: lost?.failed };
  }

  private member(real: object, key: string, text: string): unknown {
    const value: unknown = Reflect.get(real, key, real);
    if (typeof value === 'function') return (...args: unknown[]) => this.call(value, real, text, args);
    return this.given(value, text);
  }

  /**
   * An object the code got at once keeps its text, so a later line that takes
   * it spells it the same way. One with members of its own is wrapped, so its
   * calls are recorded too. Plain data, such as a credential and the secret
   * handle inside it, stays itself; an array stays an array, of items given
   * the same way; and a promise is the code's own to await.
   */
  private given(value: unknown, text: string, depth = 0): unknown {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null || isThenable(value)) return value;
    if (Array.isArray(value) && !isData(value, 0) && depth < MAX_DEPTH) {
      const items = value.map((item, index) => this.given(item, `${text}[${String(index)}]`, depth + 1));
      this.sources.set(items, text);
      return items;
    }
    if (!isData(value, 0)) return this.wrap(value, text);
    this.sources.set(value, text);
    if (depth < MAX_DEPTH && isPlainObject(value)) for (const [key, item] of Object.entries(value)) this.given(item, memberText(text, key), depth + 1);
    return value;
  }

  private call(method: object, receiver: object | undefined, text: string, args: unknown[]): unknown {
    if (this.turn === 'cut') return PARKED;
    const spelled = (line: boolean): string => `${text}(${args.map((arg) => this.spell(arg, 0, line)).join(', ')})`;
    const called = spelled(false);
    const recording = this.turn === 'running' && insideFunction.getStore() === undefined;
    // Asked before the call runs: a line the call itself makes, as a poll's read is, does not run alongside it.
    const alongside = this.pending.size > 0;
    let returned: unknown;
    try {
      returned = Reflect.apply(method as (...values: unknown[]) => unknown, receiver, args.map((arg) => this.real(arg, 0)));
    } catch (cause) {
      if (recording) this.slots.push({ source: `${called};`, error: classifyError(cause) });
      throw cause;
    }
    if (!isThenable(returned)) return this.given(returned, called);
    // A line's own strings are written by name where a test has one; a step of a chain, such as the query that finds a field, keeps what it was given.
    return recording ? this.line(spelled(true), returned, text, args, alongside ? ALONGSIDE : '') : Promise.resolve(returned).then((value) => this.given(value, called));
  }

  private line(called: string, returned: PromiseLike<unknown>, text: string, args: readonly unknown[], note: string): Promise<unknown> {
    const source = `await ${called};`;
    const slot = this.slots.push(undefined) - 1;
    const line = new Line<unknown>((resolve, reject) => {
      returned.then((value) => {
        if (value instanceof KeptFailure) {
          this.slots[slot] = { source, error: classifyError(value.cause) };
          resolve(undefined);
        } else resolve(this.resolved(value, slot, source, note, text, args));
      }, reject);
    });
    const sent: Sent = { line, failed: undefined, settled: Promise.resolve() };
    // Not through the line's own `then`, which would count as the code waiting on it.
    sent.settled = Promise.prototype.then.call(
      line,
      () => undefined,
      (cause: unknown) => {
        sent.failed = { cause };
        this.slots[slot] = { source, error: classifyError(cause) };
      },
    ).finally(() => this.pending.delete(sent));
    this.sent.push(sent);
    this.pending.add(sent);
    return sent.line;
  }

  /**
   * Plain data is the line's value. Anything with members of its own, such
   * as a new tab or a list of locators, gets a name, since a test cannot
   * chain on a promise: the line that made it declares the name and later
   * lines call it by that.
   */
  private resolved(value: unknown, slot: number, source: string, alongside: string, text: string, args: readonly unknown[]): unknown {
    let note = alongside;
    // A function the server calls is written as its text, which leaves behind the variables of the code it used. A page script is sent as text and never had them.
    if (this.functions.some((code) => !this.sentAsText.has(code) && source.includes(Function.prototype.toString.call(code)))) note = `${CALLBACK}${note}`;
    if (isData(value, 0)) {
      // A call that gives a value back only read, unless it ran a function of the code's, which may have changed the app.
      const read = value !== undefined && this.reading.has(rootOf(text)) && !ANSWERING_ACTIONS.has(text.slice(text.lastIndexOf('.') + 1)) && !args.some((arg) => holdsFunction(arg, 0));
      this.slots[slot] = { source: read ? source : `${source}${note}`, read, value };
      return value;
    }
    const member = text.slice(text.lastIndexOf('.') + 1);
    const name = `${IDENTIFIER.test(member) ? member : 'object'}${String(this.nextHandle())}`;
    if (this.reading.has(rootOf(text))) this.reading.add(name);
    this.slots[slot] = { source: `const ${name} = ${source}${note}`, read: false, value: undefined };
    return this.given(value, name);
  }

  /** An argument as the real object takes it: what the code holds wrapped goes in as itself. */
  private real(value: unknown, depth: number): unknown {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null || depth > MAX_DEPTH) return value;
    const real = this.reals.get(value);
    if (real !== undefined) return real;
    // A constructor or a built-in, such as the `String` of `expect.any(String)`, is known by its identity and has no code of the caller's to run.
    if (typeof value === 'function') return isCallback(value) ? this.handler(value) : value;
    // Rebuilt only around something wrapped, so an object the code made, or a secret's handle, goes in as itself.
    if (Array.isArray(value)) {
      const items = value.map((item) => this.real(item, depth + 1));
      return items.every((item, index) => item === value[index]) ? value : items;
    }
    if (!isPlainObject(value)) return value;
    const entries = Object.entries(value).map(([key, item]) => [key, this.real(item, depth + 1)] as const);
    return entries.every(([key, item]) => item === Reflect.get(value, key)) ? value : Object.fromEntries(entries);
  }

  /**
   * A function of the code as the real object gets it: run in the context of
   * the call that passed it. An engine calls a handler from its own
   * connection's context, where an error the handler leaves would belong to
   * no call and reach the process. One function is one handler, so removing
   * it by itself still finds it.
   */
  private handler(code: object): object {
    const known = this.handlers.get(code);
    if (known !== undefined) return known;
    const inCall = AsyncLocalStorage.snapshot();
    const handler = function (this: unknown, ...args: unknown[]): unknown {
      return inCall(() => insideFunction.run(true, () => Reflect.apply(code as (...values: unknown[]) => unknown, this, args)));
    };
    // An engine sends a page script as its text, and a handler may be told apart by its arity.
    Object.defineProperties(handler, {
      toString: {
        value: () => {
          this.sentAsText.add(code);
          return Function.prototype.toString.call(code);
        },
      },
      name: { value: Reflect.get(code, 'name') },
      length: { value: Reflect.get(code, 'length') },
    });
    this.handlers.set(code, handler);
    return handler;
  }

  /** An argument as a test would write it. */
  private spell(value: unknown, depth: number, byName = false): string {
    if (typeof value === 'string' && byName) {
      const named = this.named(value);
      if (named !== undefined) return named;
    }
    if (typeof value === 'string') return `'${this.redact(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r')}'`;
    if (typeof value === 'bigint') return `${String(value)}n`;
    if (typeof value !== 'object' && typeof value !== 'function') return String(value);
    if (value === null) return 'null';
    const known = this.sources.get(value);
    if (known !== undefined) return known;
    if (typeof value === 'function' && !isCallback(value)) return String(Reflect.get(value, 'name'));
    if (typeof value === 'function') {
      this.functions.push(value);
      return Function.prototype.toString.call(value);
    }
    if (value instanceof RegExp) return String(value);
    if (depth > MAX_DEPTH) return 'undefined';
    if (Array.isArray(value)) return `[${value.map((item) => this.spell(item, depth + 1, byName)).join(', ')}]`;
    if (value instanceof Date) return `new Date(${String(value.getTime())})`;
    if (!isPlainObject(value)) return `/* ${value.constructor?.name ?? 'object'} */ undefined`;
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    return `{ ${entries.map(([key, item]) => `${IDENTIFIER.test(key) ? key : JSON.stringify(key)}: ${this.spell(item, depth + 1, byName)}`).join(', ')} }`;
  }
}

/** A member under a symbol, such as an iterator: called on the real object, whose private fields a wrapper does not have. */
function own(real: object, key: symbol): unknown {
  const value: unknown = Reflect.get(real, key, real);
  return typeof value === 'function' ? (value.bind(real) as unknown) : value;
}

/** Test API calls that give a value back and still act: a locator's screenshot scrolls the app and leaves a file. */
const ANSWERING_ACTIONS: ReadonlySet<string> = new Set(['screenshot']);

/** The first name of a line's text: the object in scope it starts from. */
function rootOf(text: string): string {
  return /^[A-Za-z_$][\w$]*/.exec(text)?.[0] ?? '';
}

/** Spells member `key` of `text` the way code would read it: `a.b`, `a[0]`, or `a["eu-west"]`. */
function memberText(text: string, key: string): string {
  if (/^\d+$/.test(key)) {
    return `${text}[${key}]`;
  }

  return IDENTIFIER.test(key) ? `${text}.${key}` : `${text}[${JSON.stringify(key)}]`;
}

/** Whether a function is code the caller wrote to be called, and not a class or a built-in passed by name. */
function isCallback(value: object): boolean {
  const source = Function.prototype.toString.call(value);
  return !source.startsWith('class') && !/\{\s*\[native code\]\s*\}$/.test(source);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && typeof Reflect.get(value, 'then') === 'function';
}

/** Whether a value is plain data all the way down, with no members of its own to call. */
function isData(value: unknown, depth: number): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return true;
  if (typeof value !== 'object' || depth > MAX_DEPTH) return false;
  // Values with internal slots, which only their own object can answer for: wrapped, a buffer's bytes or a map's entries are out of reach.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Map || value instanceof Set || value instanceof Date || value instanceof RegExp || value instanceof URL) return true;
  if (Array.isArray(value)) return value.every((item) => isData(item, depth + 1));
  if (!isPlainObject(value)) return false;
  return Object.values(value).every((item) => isData(item, depth + 1));
}

function holdsFunction(value: unknown, depth: number): boolean {
  if (typeof value === 'function') return true;
  if (typeof value !== 'object' || value === null || depth > MAX_DEPTH) return false;
  if (Array.isArray(value)) return value.some((item) => holdsFunction(item, depth + 1));
  return isPlainObject(value) && Object.values(value).some((item) => holdsFunction(item, depth + 1));
}
