/**
 * Types for configured services, including the input to `defineService` and
 * the values tests and `env` functions receive.
 * Re-exported from `types.ts`.
 */

/** Context passed to a service's `start` function. */
export type ServiceStartContext = {
  /**
   * Aborts in these cases:
   *
   * - Startup is cancelled, or the service doesn't yield within
   *   `startupTimeout` (60 seconds by default).
   * - When the services are no longer needed, the code after `yield` doesn't
   *   finish within `shutdownTimeout` (10 seconds by default).
   * - Ctrl+C is pressed a second time in `e2e run` or `e2e explore`, either
   *   during the tests or while services are stopping.
   */
  readonly signal: AbortSignal;
};

/**
 * A dependency of the app under test (like an email API, an OAuth provider,
 * or a database) started before the app commands and stopped at the end of
 * the run. One instance is shared across all workers.
 */
export type Service<Value extends object = object> = {
  /**
   * Milliseconds the service gets to yield (default 60000). When the timeout
   * passes, the service's signal aborts and startup fails with
   * `SERVICE_START_FAILED`.
   */
  startupTimeout?: number;
  /**
   * Milliseconds the code after `yield` gets to finish (default 10000). When
   * the timeout passes, the signal aborts and the runner stops waiting.
   */
  shutdownTimeout?: number;
  /**
   * Starts the dependency and stops it when it's no longer needed. This async
   * generator yields the service value once, and the config and tests receive
   * it.
   */
  start(context: ServiceStartContext): AsyncGenerator<Value, void, undefined>;
};

/** Configured services, keyed by name. */
export type ServiceMap = Readonly<Record<string, Service>>;

/** Built-in classes that keep their type when copied with `v8.serialize`. */
type CopiedValue = Date | RegExp | ReadonlyMap<unknown, unknown> | ReadonlySet<unknown> | ArrayBuffer | ArrayBufferView | Error;

/** Values with no copy to give tests. */
type RefusedValue = SharedArrayBuffer | Promise<unknown> | WeakMap<object, unknown> | WeakSet<object> | symbol;

/** Values that are copied as they are, with nothing inside to check. */
type CopiedLeaf = string | number | boolean | bigint | null | undefined | Date | RegExp | ArrayBuffer | ArrayBufferView | Error;

/**
 * The type a function argument or result must have to be copied between a test
 * and the runner. Functions and values that can't be copied (`URL`,
 * `URLSearchParams`, `Promise`, `SharedArrayBuffer`, `WeakMap`, `WeakSet`, and
 * symbols) map to `never`. Maps, sets, plain objects, and arrays are checked
 * recursively.
 */
type CopiedData<Value> = Value extends URL | URLSearchParams
  ? never
  : Value extends ReadonlyMap<infer Key, infer Item>
    ? ReadonlyMap<CopiedData<Key>, CopiedData<Item>>
    : Value extends ReadonlySet<infer Item>
      ? ReadonlySet<CopiedData<Item>>
      : Value extends RefusedValue
        ? never
        : Value extends CopiedLeaf
          ? Value
          : Value extends (...args: never) => unknown
            ? never
            : Value extends object
              ? { [Key in keyof Value]: CopiedData<Value[Key]> }
              : Value;

/**
 * The type a value nested inside a yielded service value must have. Plain
 * objects and arrays can hold functions whose arguments and results are
 * `CopiedData`. Maps and sets can hold only `CopiedData`. `URL`,
 * `URLSearchParams`, `Promise`, `SharedArrayBuffer`, `WeakMap`, `WeakSet`, and
 * symbols map to `never`.
 */
type CopyableValue<Value> = Value extends URL | URLSearchParams
  ? never
  : Value extends ReadonlyMap<unknown, unknown> | ReadonlySet<unknown>
    ? CopiedData<Value>
    : Value extends RefusedValue
      ? never
      : Value extends CopiedLeaf
        ? Value
        : Value extends (...args: infer Args) => infer Result
          ? Args extends CopiedData<Args>
            ? (...args: Args) => CopiedData<Awaited<Result>> | Promise<CopiedData<Awaited<Result>>>
            : never
          : Value extends object
            ? { [Key in keyof Value]: CopyableValue<Value[Key]> }
            : Value;

/**
 * The type a yielded service value must have. A yielded value is a plain object
 * whose values are `CopyableValue`. An array, a map, a set, a function, or a
 * built-in like `Date` maps to `never` at the top level, because only a plain
 * object is accepted by the runner there. In `defineService`, the yielded type
 * is compared with this type.
 */
export type CopyableServiceValue<Value> = Value extends readonly unknown[] | ReadonlyMap<unknown, unknown> | ReadonlySet<unknown> | CopiedLeaf | ((...args: never) => unknown)
  ? never
  : CopyableValue<Value>;

/**
 * A yielded service value as seen in tests. Plain objects and arrays keep
 * their shape, and every function becomes an async function called in the
 * runner process. `SharedArrayBuffer` can't be copied, so it maps to `never`.
 */
export type ServiceValue<Value> = Value extends (...args: infer Args) => infer Result
  ? (...args: Args) => Promise<Awaited<Result>>
  : Value extends SharedArrayBuffer
    ? never
    : Value extends CopiedValue
      ? Value
      : Value extends object
        ? { [Key in keyof Value]: ServiceValue<Value[Key]> }
        : Value;

/** Service values from `Services`, keyed by name, as tests and `env` functions receive them. */
export type ServiceValues<Services> = {
  readonly [Name in keyof Services]: Services[Name] extends Service<infer Value> ? ServiceValue<Value> : never;
};
