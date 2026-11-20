import { ActionDispatcher, type ActionDispatcherOptions } from './action-dispatcher.ts';
import type { StepExecutorContext } from './executor.ts';
import type { AgentContext } from './invocation.ts';
import { tokenUpperBound } from './model/adapter.ts';
import { ObservationFeed, type ObservationFeedOptions } from './observation-feed.ts';
import { OperationQueue } from './operation-queue.ts';
import { StepAccounting, type StepAccountingOptions } from './step-accounting.ts';

type StepExecutionOptions = {
  readonly accounting: StepAccountingOptions;
  readonly observation: Omit<ObservationFeedOptions, 'instructionBytes'>;
  readonly actions: ActionDispatcherOptions;
};

export type StepExecutionBindings = Pick<StepExecutorContext, 'budgets' | 'observe' | 'read' | 'actions'>;

export type StepExecution = {
  accounting: StepAccounting;
  feed: ObservationFeed;
  bindings: StepExecutionBindings;
};

/** Builds the step machinery and the executor context methods it backs. */
export function createStepExecution(runtime: AgentContext, options: StepExecutionOptions): StepExecution {
  const accounting = new StepAccounting(runtime, options.accounting);
  // One queue for observations and actions alike: call order is what keeps
  // a batched turn from resolving two targets against one stale screen.
  const queue = new OperationQueue();
  const feed = new ObservationFeed(runtime, accounting, queue, {
    ...options.observation,
    instructionBytes: tokenUpperBound(options.actions.instruction),
  });
  const dispatcher = new ActionDispatcher(runtime, accounting, feed, queue, options.actions);
  const bindings: StepExecutionBindings = {
    budgets: {
      maxActions: accounting.maxActions,
      maxModelCalls: accounting.maxModelCalls,
      actionsUsed: () => accounting.metrics.actionSteps,
      remainingMs: () => accounting.remainingMs(),
      recordModelCall: (usage) => accounting.recordModelCall(usage),
      runTool: (call, body) => dispatcher.runTool(call, body),
    },
    observe: (observeOptions) => feed.observe(observeOptions),
    read: (target, readOptions) => feed.read(target, readOptions),
    actions: dispatcher.actions,
  };
  return { accounting, feed, bindings };
}
