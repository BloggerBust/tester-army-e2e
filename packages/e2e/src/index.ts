/** Public sdk-0.1 entrypoint. */

export { afterAll, afterEach, beforeAll, beforeEach, describe, test } from './collect/registry.ts';
export { expect } from './expect/index.ts';
export { credentials, secrets } from '@e2e-dev/core/lib/secrets';
export { unique } from '@e2e-dev/core/lib/params';
export { AgentError, isAgentError } from '@e2e-dev/core/lib/agent/error';
// The markdown page the `markdown` reporter writes, for a reporter that posts
// it elsewhere: @e2e-dev/github renders the pull request comment from it.
export { renderMarkdownReport } from './report/markdown.ts';
export type { MarkdownReportOptions } from './report/markdown.ts';

export type * from '@e2e-dev/core/lib/types';
export type * from './run-types.ts';
export type { HeldStep, NumberedStep, StepPrompt } from './run/step-hold.ts';
export type {
  ExecutorActions,
  ExecutorAttempt,
  ExecutorBudgets,
  ExecutorModelCall,
  ExecutorNode,
  ExecutorObservation,
  ExecutorObserveOptions,
  ExecutorPixels,
  ExecutorReadOptions,
  ExecutorReadResult,
  ExecutorStep,
  ExecutorTarget,
  ExecutorVerb,
  PointDragResult,
  PointHit,
  PointTapResult,
  ReplayedPrefix,
  ReplayHandOffReason,
  StepExecutor,
  StepExecutorContext,
  StepVerdict,
  StepVerdictStatus,
} from '@e2e-dev/core/lib/agent/executor';
export type { StepTurn, VisionDegradation } from '@e2e-dev/core/lib/run/steps';
export type { RunEvent, RunEventOf, RunExitCode, RunStatus } from './run/events.ts';
export type { EngineAppDeclaration } from '@e2e-dev/core/lib/engine/index';
