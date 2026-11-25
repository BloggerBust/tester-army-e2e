/**
 * The fixture rules that need a target, checked at selection: once the pairs
 * that run are known, and before any worker starts. Only a pair that runs is
 * checked, so a file whose `beforeAll` names `app` and is skipped on a web
 * target (`platforms`, `test.skipIf`) stays valid there.
 */

import { CollectionError } from '@e2e-dev/core/lib/internal/errors';
import type { Collection } from './collect.ts';
import { declarationSite, FixtureUseError } from './fixture-errors.ts';
import { planAttempt, planSuiteHook } from './fixture-plan.ts';
import { hooksFor, type ModuleRegistration, type RegisteredHook, type SuiteHook, type TestHook } from './registry.ts';
import type { TestTargetPair } from './select.ts';

function isSuiteHook(hook: RegisteredHook): hook is SuiteHook {
  return hook.kind === 'beforeAll' || hook.kind === 'afterAll';
}

/**
 * Plans the fixtures of every pair that runs, and of the suite hooks of the
 * scopes it enters, on the pair's target. The first rule one breaks is a
 * `COLLECTION_ERROR` that opens with where the code was declared: a name no
 * target in the config has a fixture for, a test fixture named by a suite
 * hook or a worker fixture, a cycle.
 */
export function assertFixtureUse(pairs: readonly TestTargetPair[], collection: Collection, projectRoot: string): void {
  const registrations = new Map<string, ModuleRegistration>(collection.files.map((file) => [file.file, file.registration]));
  // A test runs once per agent and repeat, and a suite hook serves every test of its scope.
  const planned = new Set<string>();
  const plannedHooks = new Map<string, Set<SuiteHook>>();
  for (const { test, target, disposition } of pairs) {
    if (disposition !== 'run') continue;
    const key = `${target.name}::${test.id}`;
    if (planned.has(key)) continue;
    planned.add(key);
    const registration = registrations.get(test.file);
    const hooks = registration === undefined ? [] : hooksFor(registration, test);
    const seen = plannedHooks.get(target.name) ?? new Set<SuiteHook>();
    plannedHooks.set(target.name, seen);
    try {
      planAttempt(target, test, hooks.filter((hook): hook is TestHook => !isSuiteHook(hook)));
      for (const hook of hooks.filter(isSuiteHook)) {
        if (seen.has(hook)) continue;
        seen.add(hook);
        planSuiteHook(target, hook);
      }
    } catch (cause) {
      if (!(cause instanceof FixtureUseError)) throw cause;
      throw new CollectionError(`${declarationSite(cause, projectRoot, test.file)}: ${cause.message}`, { cause });
    }
  }
}
