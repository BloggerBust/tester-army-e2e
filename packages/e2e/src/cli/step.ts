/**
 * `e2e run --step`: the run's first step runs on its own, then every later
 * one waits for a key. The runner holds each step and `screen.pause()` call
 * through its `hold` hook; this module answers it from the keyboard, one
 * prompt at a time, and the runner draws the prompt.
 */

import type { Keypress } from './keyboard.ts';
import type { PausedKey } from '../run/events.ts';
import type { BeforeStep, HeldStep, NumberedStep, StepHoldContext, StepPrompt } from '../run/step-hold.ts';
import { pairKey } from '../run/units.ts';

/** Screen and app log views available at the step prompt. */
export type StepView = 'screen' | 'logs';

/** A key the step prompt acts on. Ctrl-C, Ctrl-D, and Ctrl-Z arrive as keypresses in raw mode, not as signals. */
export type StepKey = 'continue' | 'test' | 'rest' | 'help' | 'stop' | 'interrupt' | 'suspend' | StepView;

/**
 * The step key a keypress means, or none. The keys follow `--watch`, as
 * vitest's do: Enter goes on, `a` runs all, `h` shows the keys, `q` and
 * Escape quit.
 */
export function stepKeyOf(press: Keypress): StepKey | undefined {
  if (press.ctrl) {
    if (press.name === 'c' || press.name === 'd') return 'interrupt';
    return press.name === 'z' ? 'suspend' : undefined;
  }
  switch (press.name) {
    case 'return':
    case 'enter':
      return 'continue';
    case 'n':
      return 'test';
    case 'a':
      return 'rest';
    case 'h':
      return 'help';
    case 's':
      return 'screen';
    case 'l':
      return 'logs';
    case 'q':
    case 'escape':
      return 'stop';
    default:
      return undefined;
  }
}

/** The prompt's keys other than Enter, in `--watch`'s words. */
const STEP_KEYS: readonly (PausedKey & { readonly needs: 'viewer' | 'steps' | undefined })[] = [
  { key: 's', does: 'show the screen', needs: 'viewer' },
  { key: 'l', does: 'show the app log', needs: 'viewer' },
  { key: 'n', does: 'run this test without holding steps', needs: 'steps' },
  { key: 'a', does: 'run all without holding steps', needs: 'steps' },
  { key: 'q', does: 'quit', needs: undefined },
];

/** What `e2e run --step <action>` asks a stepped run without a terminal to do (`step-control.ts`). */
export const STEP_ACTIONS = ['next', 'rest', 'stop'] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

/** Whether `e2e run --step <value>` drives a stepped run rather than naming a file. */
export function isStepAction(value: string | undefined): value is StepAction {
  return (STEP_ACTIONS as readonly (string | undefined)[]).includes(value);
}

/** How long a prompt ignores keys after it appears: a key pressed for the step before must not run this one. */
const KEY_GUARD_MS = 150;

/** Options for a `StepGate.press` call. Set `guard` to false to skip the key guard. */
type PressOptions = { readonly guard: boolean };

type StepGateOptions = {
  readonly now?: () => number;
  readonly holdSteps?: boolean;
  /** Asked at each prompt: a run learns from its config whether the viewer has a terminal. */
  readonly viewer?: () => boolean;
  /** False when commands answer the prompt and no keyboard does. */
  readonly keyboard?: boolean;
};

/** The numbered hold and its read callbacks for the viewer. */
export type HeldPromptStep = NumberedStep & { readonly context: StepHoldContext };

/** One held step waiting for its prompt, or showing it. */
type Waiting = HeldPromptStep & {
  readonly resolve: () => void;
  readonly onAbort: () => void;
};

/** The test a step belongs to, on its target: what `t` lets through. */
function testKey(step: HeldStep): string {
  return `${step.target}\u0000${pairKey(step.testId, step.agent, step.repeat)}`;
}

/** Returns whether two waits share a prompt. They must have the same kind and test. */
function samePrompt(waiting: HeldStep, step: HeldStep): boolean {
  return waiting.kind === step.kind && testKey(waiting) === testKey(step);
}

/**
 * Answers held steps from keys, one prompt at a time, in the order the steps
 * were held. Steps of one test held together, as in one `Promise.all`, share
 * a prompt and run on one key: a wait started beside the action it waits for
 * would otherwise time out while the action waits for its key. `stop`
 * interrupts the run; the interrupt aborts every waiting step's signal,
 * which takes it off the queue.
 *
 * A pause has a separate prompt and waits every time it runs, even if it's
 * the first wait in the run. `n` stops holding steps in the current test.
 * `a` and the `rest` command stop holding steps for the run. Every pause
 * still waits, and either key resumes the test at a pause like Enter.
 */
export class StepGate {
  private readonly queue: Waiting[] = [];
  private shownAt = 0;
  private started = false;
  private runRest = false;
  /** Whether the prompt lists every key, after `h`. */
  private help = false;
  /** The test `n` let through, until its steps stop coming. */
  private released: string | undefined;
  /** The test whose steps reached the gate last. */
  private current: string | undefined;
  /** The displayed hold's callback, also used to clear its prompt. */
  private show: StepHoldContext['show'] | undefined;

  private readonly now: () => number;
  private readonly holdSteps: boolean;
  private readonly viewer: () => boolean;
  private readonly keyboard: boolean;

  /**
   * `stop` interrupts the run. `holdSteps` is false for a run without
   * `--step`, where only pauses wait and the prompt doesn't offer `n` or `a`.
   */
  constructor(
    private readonly stop: () => void,
    options: StepGateOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.holdSteps = options.holdSteps ?? true;
    this.viewer = options.viewer ?? (() => false);
    this.keyboard = options.keyboard ?? true;
  }

  /** The runner's `hold` hook. */
  readonly beforeStep: BeforeStep = (step, context) => {
    // A hold that ended before it arrived has nobody to answer.
    if (context.signal.aborted) return Promise.resolve();
    const key = testKey(step);

    if (step.kind === 'step' && this.current !== key) {
      this.current = key;
      if (this.released !== key) this.released = undefined;
    }

    // The first step runs at once, so the app is open before the first prompt.
    // A pause already has the app open.
    if (step.kind === 'pause') {
      this.started = true;
    } else if (!this.started) {
      this.started = true;
      return Promise.resolve();
    }
    if (step.kind === 'step' && (this.runRest || this.released === key)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiting: Waiting = {
        step,
        number: context.number,
        context,
        resolve,
        onAbort: () => {
          const index = this.queue.indexOf(waiting);
          if (index === -1) return;
          this.queue.splice(index, 1);
          resolve();
          if (index === 0 || this.onPrompt(step)) this.showNext();
        },
      };
      context.signal.addEventListener('abort', waiting.onAbort, { once: true });
      this.queue.push(waiting);
      // The first step held shows its prompt; a step held beside it joins that prompt.
      if (this.onPrompt(step)) this.showNext();
    });
  };

  /** Returns the hold available to read once the key guard has passed. */
  inspect(): HeldPromptStep | undefined {
    return this.now() - this.shownAt < KEY_GUARD_MS ? undefined : this.queue[0];
  }

  /** Restarts the key guard so a key from the viewer doesn't reach the prompt after the viewer closes. */
  guardKeys(): void {
    this.shownAt = this.now();
  }

  /** Acts on a prompt key once the key guard has passed. */
  press(key: Exclude<StepKey, 'interrupt' | 'suspend' | StepView>, options: PressOptions = { guard: true }): void {
    const shown = options.guard ? this.inspect() : this.queue[0];
    if (shown === undefined) return;
    const test = testKey(shown.step);
    switch (key) {
      case 'continue':
        this.release((waiting) => samePrompt(waiting.step, shown.step));
        return;
      case 'test':
        this.released = test;
        this.release((waiting) => samePrompt(waiting.step, shown.step) || (waiting.step.kind === 'step' && testKey(waiting.step) === test));
        return;
      case 'rest':
        this.runRest = true;
        this.release((waiting) => samePrompt(waiting.step, shown.step) || waiting.step.kind === 'step');
        return;
      case 'help':
        // The same steps, so the key guard keeps running.
        this.help = !this.help;
        this.show?.(this.prompt());
        return;
      case 'stop':
        this.stop();
    }
  }

  /** Returns whether `step` belongs to the prompt currently shown. */
  private onPrompt(step: HeldStep): boolean {
    const shown = this.queue[0];
    return shown !== undefined && samePrompt(shown.step, step);
  }

  /** Lets every waiting step `which` picks run, then shows the next prompt. */
  private release(which: (waiting: Waiting) => boolean): void {
    for (const waiting of this.queue.filter(which)) {
      this.queue.splice(this.queue.indexOf(waiting), 1);
      waiting.context.signal.removeEventListener('abort', waiting.onAbort);
      waiting.resolve();
    }
    this.showNext();
  }

  /** Shows the next prompt, or takes the prompt down when no step waits. */
  private showNext(): void {
    this.guardKeys();
    const show = this.queue[0]?.context.show;
    const draw = show ?? this.show;
    this.show = show;
    draw?.(this.prompt());
  }

  /** The prompt for the step first in the queue and the steps of its test held beside it, or none. */
  private prompt(): StepPrompt | undefined {
    const [first, ...rest] = this.queue;
    if (first === undefined) return undefined;
    const numbered = ({ step, number }: Waiting): NumberedStep => ({ step, number });
    const steps: [NumberedStep, ...NumberedStep[]] = [numbered(first), ...rest.filter((waiting) => samePrompt(waiting.step, first.step)).map(numbered)];
    const keys = this.keyboard
      ? stepPromptKeys({ pause: first.step.kind === 'pause', steps: steps.length, help: this.help, holdSteps: this.holdSteps, viewer: this.viewer() })
      : [];
    return { steps, holdSteps: this.holdSteps, keys };
  }
}

/** The keys a prompt lists: Enter, then `h` and `q`, or every key once `h` asked for them. */
export function stepPromptKeys(prompt: { pause: boolean; steps: number; help: boolean; holdSteps: boolean; viewer: boolean }): PausedKey[] {
  const enter = { key: 'enter', does: prompt.pause ? 'resume' : prompt.steps === 1 ? 'run this step' : `run these ${prompt.steps} steps` };
  if (!prompt.help) return [enter, { key: 'h', does: 'show help' }, { key: 'q', does: 'quit' }];
  const offered = STEP_KEYS.filter(({ needs }) => needs === undefined || (needs === 'viewer' ? prompt.viewer : prompt.holdSteps));
  return [enter, ...offered.map(({ key, does }) => ({ key, does }))];
}
