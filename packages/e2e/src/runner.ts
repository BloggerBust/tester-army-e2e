/** Runner APIs live on e2e/runner so importing e2e does not load them; ConfigurationError is shared with e2e/engine. */
export { ConfigurationError, isE2EError, type SerializedError } from '@e2e-dev/core/lib/internal/errors';
import { redactOpening } from '@e2e-dev/core/lib/run/redact-opening';
import { list as listSelection, type ListOptions, type ListResult } from './run/runner.ts';
import { runExploration, type ExplorationOptions, type ExplorationResult } from './explore/public-explore.ts';

export { type ListOptions, type ListResult, type ListedPair } from './run/runner.ts';
export { runSuite as run, type SuiteRunOptions as RunOptions, type RunResult } from './run/public-run.ts';
export { type ExplorationOptions as ExploreOptions, type ExplorationResult as ExploreResult } from './explore/public-explore.ts';

/**
 * Collects and selects like `e2e list` and stops there: no app process, no
 * engine prepare, no worker. Every pair is returned, filtered ones included,
 * in selection order, one per test, target, and agent; repeats are not
 * expanded. `unmatched` is the positional arguments that selected no file,
 * `targets` the selected target names in config order. An empty selection
 * throws `NO_TESTS` unless `passWithNoTests`. Config, collection, and
 * selection failures throw the same classified error `run` records, redacted
 * and without its raw cause, as `openHost` throws: a config that loads a key
 * and then fails may quote it. Each call imports the test files again, so a
 * later call sees an edit. With `changedSince`, the configured test filters
 * then judge the selection, which may call a model: a pair one left out is
 * `filtered`, with its `filter` and `reason`, and a selection they leave empty
 * resolves.
 */
export function list(options: ListOptions = {}): Promise<ListResult> {
  return redactOpening(() => listSelection(options));
}

/**
 * Explores the app toward a goal without exiting the caller; await its
 * cleanup before starting another run. A goal or budget out of range, a
 * config that does not load or resolve, an unknown target or agent, or an
 * agent with no model rejects before anything starts, as the CLI's flags
 * do, with a classified error, redacted and without its raw cause, as
 * `openHost` throws; once the run starts, failures and interruption resolve
 * with their status in the report.
 */
export function explore(options: ExplorationOptions = {}): Promise<ExplorationResult> {
  return redactOpening(() => runExploration(options));
}
export type { RunEventSink } from './run/events.ts';
export { openHost, type E2EHost, type E2ESession, type OpenHostOptions, type OpenSessionOptions } from './run/open-session.ts';
export type { StepProgress, StepRecord } from '@e2e-dev/core/lib/run/steps';
