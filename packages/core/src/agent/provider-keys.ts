/**
 * What an executor does about the keys its agent signs in with. The run
 * redacts the provider keys it finds in the environment on its own; these
 * are for an executor that knows of others, or that cuts or keeps text
 * before the run sees it.
 */

import { processSecrets, redactProviderKeys, registerProviderKey, registerProviderKeys } from '../run/secrecy.ts';
import type { StepExecutorContext } from './executor.ts';
import { executorRedactors } from './redaction.ts';

export { registerProviderKey, registerProviderKeys };

/**
 * `text` with every secret and provider key the process knows replaced by
 * its `<secret:name>` marker. The run redacts whatever an executor returns;
 * an executor calls this first on text it cuts short, since half a value is
 * no longer a match, and on text it keeps somewhere the run never reads.
 */
export function redactSecrets(text: string): string {
  return processSecrets.redact(text);
}

/**
 * `text` redacted for the step `ctx` runs: the run's secrets, the values this
 * test learned, and every provider key known now, but no value an earlier
 * test learned, which text no test built (a prompt with an executor's own
 * `system`) may hold by chance. Call it last, right before the text leaves,
 * so a key the agent's start made known is caught too. With a context the
 * run did not build, provider keys only.
 */
export function redactStepText(ctx: StepExecutorContext, text: string): string {
  return (executorRedactors.get(ctx) ?? redactProviderKeys)(text);
}
