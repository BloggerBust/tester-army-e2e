/**
 * Starts, stops, and proxies calls for configured services. Each service's
 * generator runs up to `yield` before app commands start and resumes after
 * they stop.
 *
 * Workers and sessions receive a copy of the yielded values. Each yielded
 * function becomes an async function that sends calls to the process that
 * started the service, where the real function runs and returns the result.
 */

import { deserialize, serialize } from 'node:v8';
import { errorMessage, InfrastructureError, ConfigurationError, TestError } from '@e2e-dev/core/lib/internal/errors';
import { isPlainObject } from '@e2e-dev/core/lib/internal/options';
import { holdSecretRegistry, type SecretRegistry } from '@e2e-dev/core/lib/secrets';
import type { Service } from '@e2e-dev/core/lib/types';

/** Marker returned when a wait ends because the runner stopped waiting. */
const ABORTED = Symbol('aborted');

/** A path into a value: object keys and array indexes. */
type ValuePath = readonly (string | number)[];

/** A yielded service function, called with arguments from a test. */
type ServiceFunction = (args: readonly unknown[]) => unknown;

/**
 * Serialized service values sent to a worker. `data` holds the base64-encoded
 * values keyed by service name, with `null` in place of each function.
 * `functions` lists the path to each replaced function so calls can reference
 * them by index.
 */
export type ServiceWire = {
  readonly data: string;
  readonly functions: readonly ValuePath[];
};

/**
 * Base64-encoded reply for a service function call, containing either the
 * return value or the thrown error. `properties` carries extra error fields
 * that `v8.serialize` drops, like `name` and `code`.
 */
export type ServiceReply = { readonly result: string } | { readonly error: string; readonly properties: string };

/** Sends a call for function index `call` with serialized `args` to the runner process. */
export type ServiceCaller = (call: number, args: string) => Promise<ServiceReply>;

/** Tracks a service generator that has been created so it can be resumed on stop. */
type StartedService = {
  readonly name: string;
  readonly generator: AsyncGenerator<object, void, undefined>;
  readonly controller: AbortController;
  /** Result of the generator's first `next()` call. Stays pending if startup was cancelled before yielding. */
  readonly first: Promise<IteratorResult<object, void>>;
  /** Flips to `true` once `first` settles. */
  settled: boolean;
  /** Milliseconds the stop code gets before the runner stops waiting. */
  readonly shutdownTimeout: number;
};

/**
 * Options for validating and copying a value across process boundaries. Walks
 * plain objects, arrays, maps, and sets, and rejects any value that can't be
 * copied faithfully.
 */
type CopyCheck = {
  /** Destination label used in error messages, like `tests`. */
  readonly to: string;
  /** Builds the error for a value that can't be copied. `problem` describes the value, its path, and the reason. */
  readonly refuse: (problem: string) => Error;
  /** Returns the placeholder value for a function in a plain object or array. Omit to reject functions. */
  readonly onFunction?: (call: ServiceFunction, path: ValuePath) => unknown;
  /** Maps original objects to their copies so shared and circular references stay intact. */
  readonly copies: Map<object, unknown>;
};

/** Lifecycle callbacks fired while starting services. */
export type ServiceHooks = {
  starting(name: string): void;
  ready(name: string, durationMs: number): void;
  /** Called when stopping an already-started service fails after another service failed to start. */
  stopFailed(cause: unknown): void;
};

/** Started services for an active run. */
export type RunServices = {
  /** Serialized service values ready to send to workers. */
  readonly wire: ServiceWire;
  /** Runs a service function with serialized arguments and resolves to its serialized result or error. */
  readonly call: ServiceCaller;
  /**
   * Stops all started services in reverse order. Any failure is passed to
   * `onFailure` without preventing the remaining services from stopping.
   */
  stop(onFailure: (cause: unknown) => void): Promise<void>;
};

/** Empty `RunServices` used when no services were started. */
export const NO_SERVICES: RunServices = {
  wire: { data: encode({}), functions: [] },
  call: async () => errorReply(new Error("this run doesn't have any services")),
  stop: async () => undefined,
};

/**
 * Starts `services` in order and validates each yielded value. If `signal`
 * aborts, remaining services don't start. If a service fails to start, any
 * services already created are stopped before the error is rethrown.
 *
 * When `force` aborts (a second Ctrl+C), the active service's stop signal
 * aborts along with the signals of any remaining services.
 *
 * `e2e mcp` and `openHost` start services before a session holds the
 * config's secrets, so they pass `registry`, which is held while the start
 * and stop code run. `e2e run` installs it for the whole run instead.
 */
export async function startServices(
  services: readonly (readonly [string, Service])[],
  signal: AbortSignal,
  force: AbortSignal,
  hooks: ServiceHooks,
  registry?: SecretRegistry,
): Promise<RunServices> {
  const hold = (): (() => void) => (registry === undefined ? () => undefined : holdSecretRegistry(registry));
  const started: StartedService[] = [];
  // A null prototype keeps a service named `__proto__` as a plain key.
  const values: Record<string, unknown> = Object.create(null);
  const functions: { readonly path: ValuePath; readonly call: ServiceFunction }[] = [];
  const copies = new Map<object, unknown>();

  const stop = async (onFailure: (cause: unknown) => void): Promise<void> => {
    const stopping = started.splice(0).toReversed();
    const release = hold();

    // A forced stop aborts every service's signal right away, since one
    // service's stop code can wait on another that stops after it.
    const abortAll = (): void => {
      for (const service of stopping) {
        service.controller.abort();
      }
    };

    if (force.aborted) {
      abortAll();
    } else {
      force.addEventListener('abort', abortAll, { once: true });
    }

    try {
      for (const service of stopping) {
        try {
          await stopService(service, force);
        } catch (cause) {
          onFailure(cause);
        }
      }
    } finally {
      force.removeEventListener('abort', abortAll);
      release();
    }
  };

  const release = hold();

  try {
    for (const [name, service] of services) {
      if (signal.aborted) {
        break;
      }

      hooks.starting(name);

      // A handler of the starting event can cancel the run.
      if (signal.aborted) {
        break;
      }

      const startedAt = Date.now();
      const value = await startService(name, service, signal, started);

      if (value === ABORTED) {
        break;
      }

      if (!isPlainObject(value)) {
        throw new ConfigurationError('INVALID_SERVICE_VALUE', `service "${name}" yielded ${describe(value)}. Yield a plain object, like { url }`);
      }

      values[name] = copyValue(value, [], {
        to: 'tests',
        refuse: (problem) => new ConfigurationError('INVALID_SERVICE_VALUE', `service "${name}" yielded ${problem}`),
        onFunction: (call, path) => {
          functions.push({ path: [name, ...path], call });

          return null;
        },
        copies,
      });

      hooks.ready(name, Date.now() - startedAt);
    }

    return {
      wire: { data: encode(values), functions: functions.map(({ path }) => path) },
      call: async (call, args) => {
        const entry = functions[call];

        if (entry === undefined) {
          return errorReply(new Error(`no service function has index ${call}`));
        }

        let result: unknown;

        try {
          const decoded = decode(args);

          result = await entry.call(Array.isArray(decoded) ? decoded : []);
        } catch (cause) {
          return errorReply(cause);
        }

        try {
          const copy = copyValue(result, [], {
            to: 'the caller',
            refuse: (problem) => new Error(`it returned ${problem}`),
            copies: new Map(),
          });

          return { result: encode(copy) };
        } catch (cause) {
          return errorReply(cause);
        }
      },
      stop,
    };
  } catch (cause) {
    await stop((failure) => hooks.stopFailed(failure));

    throw cause;
  } finally {
    release();
  }
}

/**
 * Runs one service's generator up to its `yield`. The service is added to
 * `started` as soon as the generator is created, so cleanup still resumes it
 * if it yields after the runner stops waiting.
 *
 * Returns the yielded value, or `ABORTED` if `signal` aborts first (the run
 * was cancelled). The service's signal aborts when the run is cancelled or
 * when startup doesn't yield within the service's `startupTimeout`.
 */
async function startService(name: string, service: Service, signal: AbortSignal, started: StartedService[]): Promise<unknown> {
  const limitMs = service.startupTimeout ?? 60_000;

  const controller = new AbortController();

  let generator: AsyncGenerator<object, void, undefined>;

  try {
    generator = service.start({ signal: controller.signal });
  } catch (cause) {
    throw startFailure(name, cause);
  }

  const returned: unknown = generator;

  if (typeof returned !== 'object' || returned === null || !(Symbol.asyncIterator in returned)) {
    // An async `start` that isn't a generator returns a promise, and its rejection would go unhandled.
    void Promise.resolve(returned).catch(() => undefined);

    throw new InfrastructureError('SERVICE_START_FAILED', `service "${name}" needs an async generator for start, like async *start() { ... }`);
  }

  // Run inside `then()` so a synchronous throw from `next()` is handled the same way as a rejection.
  const first = Promise.resolve()
    .then(() => generator.next())
    .catch((cause: unknown) => {
      throw startFailure(name, cause);
    });

  const entry: StartedService = { name, generator, controller, first, settled: false, shutdownTimeout: service.shutdownTimeout ?? 10_000 };

  const settle = (): void => {
    entry.settled = true;
  };

  void first.then(settle, settle);

  started.push(entry);

  const timer = setTimeout(() => {
    controller.abort(new InfrastructureError('SERVICE_START_FAILED', `service "${name}" didn't yield within ${limitMs / 1000} seconds`));
  }, limitMs);

  const cancel = (): void => controller.abort(signal.reason);

  signal.addEventListener('abort', cancel, { once: true });

  try {
    const aborted = new Promise<typeof ABORTED>((resolve) => {
      if (controller.signal.aborted) {
        resolve(ABORTED);
      } else {
        controller.signal.addEventListener('abort', () => resolve(ABORTED), { once: true });
      }
    });

    const result = await Promise.race([first, aborted]);

    if (result === ABORTED) {
      if (signal.aborted) {
        return ABORTED;
      }

      throw controller.signal.reason;
    }

    if (result.done === true) {
      throw new InfrastructureError(
        'SERVICE_START_FAILED',
        `service "${name}" finished without yielding. Yield a value once between the startup code and the stop code`,
      );
    }

    return result.value;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}

/**
 * Resumes a service's generator past `yield` to run its stop code. If the
 * service was cancelled during startup, it's resumed once it yields. Services
 * that failed or finished without yielding don't need to be stopped.
 *
 * When `force` aborts, the service's signal aborts so its stop code can exit
 * early. If the service hasn't yielded yet at that point, the runner stops
 * waiting and skips its stop code. The signal also aborts if shutdown passes
 * the service's `shutdownTimeout`, after which the runner stops waiting. A second `yield` fails
 * shutdown, and `return()` closes the generator so its `finally` blocks run.
 * A service that still hasn't yielded when `shutdownTimeout` passes isn't a
 * stop failure, since its stop code hasn't started.
 */
async function stopService({ name, generator, controller, first, settled, shutdownTimeout: limitMs }: StartedService, force: AbortSignal): Promise<void> {
  let resumed = false;

  let resolveForced = (): void => undefined;

  const forced = new Promise<false>((resolve) => {
    resolveForced = () => resolve(false);
  });

  const abort = (): void => {
    controller.abort();
    resolveForced();
  };

  if (force.aborted) {
    abort();
  } else {
    force.addEventListener('abort', abort, { once: true });
  }

  let timer: NodeJS.Timeout | undefined;

  const expired = new Promise<typeof ABORTED>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(ABORTED);
    }, limitMs);
  });

  const untilStopped = async <T>(promise: Promise<T>): Promise<T> => {
    const outcome = await Promise.race([promise, expired]).catch((cause: unknown) => {
      throw new InfrastructureError('SERVICE_STOP_FAILED', `service "${name}" failed to stop: ${errorMessage(cause)}`, { cause });
    });

    if (outcome !== ABORTED) {
      return outcome;
    }

    void promise.catch(() => undefined);

    throw new InfrastructureError('SERVICE_STOP_FAILED', `service "${name}" didn't stop within ${limitMs / 1000} seconds`);
  };

  try {
    const outcome = first.then((result) => result.done !== true, () => false);

    // Skip the race once `first` has settled. If `forced` is already settled
    // too, `Promise.race` could pick it and skip stop code for a service that
    // already yielded after a second Ctrl+C. A service that hasn't yielded
    // has no stop code to run yet, so running out of time here isn't a stop
    // failure: the code in `finally` still runs it if the service yields later.
    const yielded = settled ? await untilStopped(outcome) : await Promise.race([outcome, forced, expired.then(() => false)]);

    if (!yielded) {
      return;
    }

    resumed = true;

    const next = await untilStopped(generator.next());

    if (next.done !== true) {
      await untilStopped(generator.return(undefined));

      throw new InfrastructureError(
        'SERVICE_STOP_FAILED',
        `service "${name}" yielded a second time. Yield only once, and put stop code after the yield`,
      );
    }
  } finally {
    clearTimeout(timer);
    force.removeEventListener('abort', abort);

    // The runner stopped waiting before the service yielded. If it yields
    // later, its stop code still runs, so whatever it started is released.
    if (!resumed) {
      void first
        .then(async (result) => {
          if (result.done !== true && (await generator.next()).done !== true) {
            await generator.return(undefined);
          }
        })
        .catch(() => undefined);
    }
  }
}

/** Wraps a service startup error with the service name. */
function startFailure(name: string, cause: unknown): InfrastructureError {
  return new InfrastructureError('SERVICE_START_FAILED', `service "${name}" failed to start: ${errorMessage(cause)}`, { cause });
}

/**
 * Copies `value` and verifies that `v8.serialize` preserves its type. Walks
 * plain objects, arrays, maps, and sets, and keeps other values unchanged
 * unless copying would strip their prototype.
 *
 * Functions inside plain objects and arrays are passed to `check.onFunction`,
 * while functions inside maps or sets are rejected. When walking inside a map
 * or set, `inside` records the container type and `path` stays on that
 * container.
 */
function copyValue(value: unknown, path: ValuePath, check: CopyCheck, inside?: 'a Map' | 'a Set'): unknown {
  const container = inside === undefined ? '' : ` inside ${inside}`;
  const location = path.length === 0 ? '' : ` at ${pathLabel(path)}`;
  const where = `${container}${location}`;

  if (typeof value === 'function') {
    if (check.onFunction === undefined) {
      throw check.refuse(`a function${where}, which can't be copied to ${check.to}`);
    }

    if (inside !== undefined) {
      throw check.refuse(`a function${where}, but only plain objects and arrays can hold functions for tests`);
    }

    return check.onFunction((args) => Reflect.apply(value, undefined, args), path);
  }

  if (typeof value === 'object' && value !== null) {
    const copied = check.copies.get(value);

    if (copied !== undefined) {
      if (inside !== undefined && reachesFunction(value, new Set())) {
        throw check.refuse(`${Array.isArray(value) ? 'an array' : 'an object'} holding a function${where}, but only plain objects and arrays can hold functions for tests`);
      }

      return copied;
    }

    if (Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype) {
      const copy: unknown[] = [];

      check.copies.set(value, copy);

      for (const [index, item] of value.entries()) {
        copy.push(copyValue(item, [...path, index], check, inside));
      }

      return copy;
    }

    if (isPlainObject(value)) {
      // Use a null prototype so a `__proto__` key stays a plain property. This copy is only used for serialization.
      const copy: Record<string, unknown> = Object.create(null);

      check.copies.set(value, copy);

      for (const [key, item] of Object.entries(value)) {
        copy[key] = copyValue(item, [...path, key], check, inside);
      }

      return copy;
    }

    if (value instanceof Map && Object.getPrototypeOf(value) === Map.prototype) {
      const copy = new Map<unknown, unknown>();

      check.copies.set(value, copy);

      for (const [key, item] of value) {
        copy.set(copyValue(key, path, check, 'a Map'), copyValue(item, path, check, 'a Map'));
      }

      return copy;
    }

    if (value instanceof Set && Object.getPrototypeOf(value) === Set.prototype) {
      const copy = new Set<unknown>();

      check.copies.set(value, copy);

      for (const item of value) {
        copy.add(copyValue(item, path, check, 'a Set'));
      }

      return copy;
    }
  }

  let clone: unknown;

  try {
    clone = deserialize(serialize(value));
  } catch (cause) {
    // For an object, v8's message names the part it couldn't clone, like the
    // source of a function property, so name the object's class instead.
    if (typeof value === 'object' && value !== null) {
      throw check.refuse(`${describe(value)}${where}, which can't be copied to ${check.to}. Put its data in a plain object`);
    }

    throw check.refuse(`a value${where} that can't be copied to ${check.to}: ${errorMessage(cause)}`);
  }

  if (typeof value === 'object' && value !== null) {
    if (Object.getPrototypeOf(clone) !== Object.getPrototypeOf(value)) {
      throw check.refuse(`${describe(value)}${where}, which loses its class when it's copied to ${check.to}. Put its data in a plain object`);
    }

    check.copies.set(value, value);
  }

  return value;
}

/**
 * Whether `value` reaches a function through plain objects, arrays, maps, and
 * sets. A map or a set that reaches an object already copied checks it this
 * way, so the result doesn't depend on the order the walk visited it in.
 */
function reachesFunction(value: unknown, seen: Set<object>): boolean {
  if (typeof value === 'function') {
    return true;
  }

  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return false;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => reachesFunction(item, seen));
  }

  if (value instanceof Map) {
    return [...value].some(([key, item]) => reachesFunction(key, seen) || reachesFunction(item, seen));
  }

  if (value instanceof Set) {
    return [...value].some((item) => reachesFunction(item, seen));
  }

  return isPlainObject(value) && Object.values(value).some((item) => reachesFunction(item, seen));
}

/** Formats a value path like property access: `email.sent`, `email.inboxes[0].read`. */
function pathLabel(path: ValuePath): string {
  return path
    .map((key, index) => {
      if (typeof key === 'number') {
        return `[${key}]`;
      }

      return index === 0 ? key : `.${key}`;
    })
    .join('');
}

/** Describes a value for error messages, like `a string`, `an array`, or `an instance of Inbox`. */
function describe(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }

  if (Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype) {
    return 'an array';
  }

  if (typeof value !== 'object') {
    return `a ${typeof value}`;
  }

  const name: unknown = Object.getPrototypeOf(value)?.constructor?.name;

  return typeof name === 'string' && name !== '' ? `an instance of ${name}` : 'an object with a prototype';
}

/** Serializes a value with `v8.serialize`, in base64 for the worker channel. */
function encode(value: unknown): string {
  return serialize(value).toString('base64');
}

/** Deserializes a base64 value produced by `encode`. */
function decode(data: string): unknown {
  return deserialize(Buffer.from(data, 'base64'));
}

/**
 * Encodes a thrown value into a `ServiceReply`. `v8.serialize` preserves a
 * built-in error's class, message, stack, and `cause`, while `properties` carries
 * `name` and any copyable own enumerable properties.
 */
function errorReply(thrown: unknown): ServiceReply {
  try {
    // `message` is copied too, since a `DOMException` keeps it in a getter that `v8.serialize` skips.
    const properties =
      thrown instanceof Error
        ? Object.fromEntries(
            Object.entries({ ...thrown, name: thrown.name, message: thrown.message, stack: thrown.stack }).filter(([, value]) => {
              try {
                serialize(value);
                return true;
              } catch {
                return false;
              }
            }),
          )
        : {};

    try {
      return { error: encode(thrown), properties: encode(properties) };
    } catch {
      // Fall back to a plain Error if the thrown value or its `cause` can't be serialized.
      return { error: encode(new Error(errorMessage(thrown))), properties: encode(properties) };
    }
  } catch {
    // Reading the error threw (like a getter that throws), so the caller still gets a reply instead of waiting forever.
    return { error: encode(new Error("the service function threw an error that can't be read")), properties: encode({}) };
  }
}

/**
 * Reconstructs service values for tests from `wire`. Every replaced function
 * becomes an async wrapper that sends calls through `caller` and resolves to
 * a copy of the result. Thrown errors come back as copies prefixed with the
 * service and function name.
 */
export function copyServiceValues(wire: ServiceWire, caller: ServiceCaller): Readonly<Record<string, unknown>> {
  const data = decode(wire.data);
  const values = isPlainObject(data) ? data : {};

  // Patch in place so objects referenced by multiple paths stay shared.
  for (const [index, path] of wire.functions.entries()) {
    // Read own properties only, so a `__proto__` key never reaches a prototype.
    const parent = path.slice(0, -1).reduce<unknown>((value, key) => (Object.hasOwn(Object(value), key) ? Reflect.get(Object(value), key) : undefined), values);

    Reflect.set(Object(parent), String(path.at(-1)), serviceFunction(index, `services.${pathLabel(path)}()`, caller));
  }

  return values;
}

/** Creates the async test wrapper for one service function. `label` names it in errors (`services.email.sent()`). */
function serviceFunction(index: number, label: string, caller: ServiceCaller): (...args: unknown[]) => Promise<unknown> {
  return async (...args) => {
    // Capture the stack before sending the call so errors point to the test line that called it.
    const callSite = new Error();

    const copy = copyValue(args, ['arguments'], {
      to: 'the service',
      refuse: (problem) => new TestError('INVALID_ARGUMENT', `${label} was passed ${problem}`),
      copies: new Map(),
    });

    const reply = await caller(index, encode(copy));

    if ('result' in reply) {
      return decode(reply.result);
    }

    const thrown = decode(reply.error);
    const error = thrown instanceof Error ? Object.assign(thrown, decode(reply.properties)) : new Error(String(thrown));

    error.message = `${label} failed: ${error.message}`;

    const frames = (stack: string | undefined): string[] => (stack ?? '').split('\n').filter((line) => line.trimStart().startsWith('at '));

    error.stack = [
      `${error.name}: ${error.message}`,
      ...frames(thrown instanceof Error ? thrown.stack : undefined),
      ...frames(callSite.stack),
    ].join('\n');

    throw error;
  };
}
