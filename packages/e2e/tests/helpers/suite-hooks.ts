/** Suite hooks for a `RealmManager` with no executor behind it: each hook gets `platform` alone, as on an engine that isolates every attempt. */

import { runHook, type SuiteHookSession } from '../../src/run/realm.ts';

export function plainSuiteHooks(platform = 'web'): () => SuiteHookSession {
  return () => ({
    run: (hook, timeoutMs) => runHook(`${hook.kind} hook`, () => hook.fn({ platform }), timeoutMs),
    close: async () => {},
  });
}
