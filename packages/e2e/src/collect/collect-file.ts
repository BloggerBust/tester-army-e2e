/** A test file's registration, and the fresh load that made it. */

import { runInLoad } from '../config/esm-hooks.ts';
import { loadModule } from '../config/load.ts';
import { collectModule, type ModuleRegistration } from './registry.ts';

/** The key of the fresh load each registration came from. */
const loadKeys = new WeakMap<ModuleRegistration, string>();

/**
 * Imports the test file at `absolutePath` afresh, in a load keyed by
 * `cacheKey`, and returns what it registered; see `loadModule` and
 * `collectModule`.
 */
export async function collectFile(
  absolutePath: string,
  cacheKey: string,
  redactTitle: (title: string) => string,
  graph?: string,
): Promise<ModuleRegistration> {
  let key: string | undefined;
  const registration = await collectModule(
    () => {
      const load = loadModule(absolutePath, cacheKey, graph);
      key = load.key;
      return load.module;
    },
    absolutePath,
    redactTitle,
  );
  if (key !== undefined) loadKeys.set(registration, key);
  return registration;
}

/**
 * Runs `work`, a test or a hook `registration` holds, as part of the load
 * that imported its file: a module the work imports is then the instance
 * the file itself imported.
 */
export function inLoadOf<T>(registration: ModuleRegistration, work: () => T): T {
  const key = loadKeys.get(registration);
  return key === undefined ? work() : runInLoad(key, work);
}
