/**
 * A `screen` over an in-memory engine for unit tests of the locator tier: the
 * engine is whatever `locate`, `observe`, `perform`, `performAt`, `viewportIntersection`, and `keyboard` the test
 * hands in, wired through the real `LocatorEngine` and `createScreen` with a
 * `StepRecorder` the test reads back. `createScreenFixture` (screen-fixture.ts)
 * is the preset over a fixed node list.
 */

import {
  defineEngine,
  KNOWN_LOCATOR_ACTION_KINDS,
  type EngineKeyboard,
  type EngineSnapshot,
  type LocatorAction,
  type LocatorActionKind,
  type LocatorExpression,
  type NodeRef,
  type OperationContext,
  type PointerAction,
  type SemanticNode,
  type ViewportPoint,
  type ViewportIntersection,
} from '@e2e-dev/core/lib/engine/index';
import { prepareObservation } from '@e2e-dev/core/lib/agent/observation';
import { createEngineSession } from '@e2e-dev/core/lib/engine/session';
import { Deadline } from '@e2e-dev/core/lib/internal/time';
import { LocatorEngine } from '@e2e-dev/core/lib/locator/engine';
import { createScreen } from '@e2e-dev/core/lib/locator/screen';
import { AttemptBudget } from '@e2e-dev/core/lib/run/budget';
import { StepRecorder } from '@e2e-dev/core/lib/run/steps';
import type { Screen } from '@e2e-dev/core/lib/types';

export interface ScreenOverOptions {
  /** Answers every `locate`, with the operation it runs under. */
  readonly locate: (expression: LocatorExpression, operation: OperationContext) => readonly SemanticNode[] | Promise<readonly SemanticNode[]>;
  /** Answers every `observe`; the root's ref is what a viewport swipe is addressed to. */
  readonly observe: () => EngineSnapshot;
  /** Receives every node action with the operation it runs under; without it the engine declares no actions. */
  readonly perform?: (ref: NodeRef, action: LocatorAction, operation: OperationContext) => void | Promise<void>;
  /** Action kinds the engine declares with `perform`; default every kind. */
  readonly actions?: readonly LocatorActionKind[];
  /** Receives every pointer action at a viewport point; with it the engine declares the `tap` pointer action. */
  readonly performAt?: (point: ViewportPoint, action: PointerAction) => void | Promise<void>;
  /** Answers every `viewportIntersection`; without it the engine declares none. */
  readonly viewportIntersection?: (ref: NodeRef) => ViewportIntersection | Promise<ViewportIntersection>;
  /** The keyboard the engine declares, if any. */
  readonly keyboard?: EngineKeyboard;
  /** Writes a screenshot under `artifactsDir` and returns its relative path; without it the engine declares no artifacts. */
  readonly screenshot?: (label: string | undefined) => string;
  /** The attempt's artifact directory; `screenshot` needs one. */
  readonly artifactsDir?: string;
  /** Told the relative path of every artifact the screen registers. */
  readonly registered?: (relativePath: string) => void;
  /** Whether the engine declares `tapModifiers`; default not. */
  readonly tapModifiers?: boolean;
  /** Action and assertion timeout in milliseconds. */
  readonly timeoutMs: number;
}

/** A screen and the recorder of its steps over the engine `options` describe. */
export function screenOver(options: ScreenOverOptions): { screen: Screen; steps: StepRecorder } {
  const { perform, performAt, screenshot, viewportIntersection } = options;
  const engine = defineEngine({
    name: 'fake',
    version: '1',
    spiVersion: 1,
    observe: async () => options.observe(),
    locate: async (expression, operation) => options.locate(expression, operation),
    ...(perform === undefined
      ? {}
      : {
          actions: options.actions ?? KNOWN_LOCATOR_ACTION_KINDS,
          perform: async (ref: NodeRef, action: LocatorAction, operation: OperationContext) => {
            await perform(ref, action, operation);
          },
        }),
    ...(performAt === undefined
      ? {}
      : {
          pointerActions: ['tap'] as const,
          performAt: async (point: ViewportPoint, action: PointerAction) => {
            await performAt(point, action);
          },
        }),
    ...(viewportIntersection === undefined
      ? {}
      : { viewportIntersection: async (ref: NodeRef) => viewportIntersection(ref) }),
    ...(options.keyboard === undefined ? {} : { keyboard: options.keyboard }),
    ...(screenshot === undefined ? {} : { artifacts: { screenshot: async (label: string | undefined) => screenshot(label) } }),
    ...(options.tapModifiers === undefined ? {} : { tapModifiers: options.tapModifiers }),
  });
  const steps = new StepRecorder('attempt');
  const signal = new AbortController().signal;
  const screen = createScreen({
    engine: new LocatorEngine({
      session: createEngineSession({ engine, targetName: 'fake' }),
      budget: new AttemptBudget(signal, new Deadline(10_000)),
      runId: 'run',
      attemptId: 'attempt',
      actionTimeout: options.timeoutMs,
      assertionTimeout: options.timeoutMs,
    }),
    steps,
    secrets: { resolve: async () => 'plaintext' },
    artifacts: { dir: options.artifactsDir ?? '', register: (_kind, relativePath) => {
        options.registered?.(relativePath);
        return relativePath;
      }, link: (url) => url },
    renderTree: (observation) =>
      prepareObservation(observation, { redact: (text) => text, redactCut: (text) => text, maxBytes: 64_000 }).text,
  });
  return { screen, steps };
}
