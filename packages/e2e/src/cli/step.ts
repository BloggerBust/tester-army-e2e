/**
 * `e2e run --step`: the run's first step runs on its own, then every later
 * one waits for a key. The runner holds each step and `screen.pause()` call
 * through its `hold` hook; this module answers it from the keyboard, one
 * prompt at a time, and the runner draws the prompt.
 */

import type { Keypress } from './keyboard.ts';
import type { BeforeStep, HeldStep, NumberedStep, StepHoldContext, StepPrompt } from '../run/step-hold.ts';
import { pairKey } from '../run/units.ts';

/** A key the step prompt acts on. Ctrl-C, Ctrl-D, and Ctrl-Z arrive as keypresses in raw mode, not as signals. */
export type StepKey = 'continue' | 'test' | 'rest' | 'help' | 'stop' | 'interrupt' | 'suspend';

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
    case 'q':
    case 'escape':
      return 'stop';
    default:
      return undefined;
  }
}

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

/** One held step waiting for its prompt, or showing it. */
interface Waiting extends NumberedStep {
  readonly context: StepHoldContext;
  readonly resolve: () => void;
  readonly onAbort: () => void;
}

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
  /** The test whose steps reached the gate last, and how many of them did. */
  private current: { readonly key: string; count: number } | undefined;
  /** Where the prompt shows; every hold's context shows it in the same place. */
  private show: StepHoldContext['show'] | undefined;

  private readonly now: () => number;
  private readonly holdSteps: boolean;

  /**
   * `stop` interrupts the run. `holdSteps` is false for a run without
   * `--step`, where only pauses wait and the prompt doesn't offer `n` or `a`.
   */
  constructor(
    private readonly stop: () => void,
    options: { readonly now?: () => number; readonly holdSteps?: boolean } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.holdSteps = options.holdSteps ?? true;
  }

  /** The runner's `hold` hook. */
  readonly beforeStep: BeforeStep = (step, context) => {
    // A hold that ended before it arrived has nobody to answer.
    if (context.signal.aborted) return Promise.resolve();
    this.show = context.show;
    const key = testKey(step);
    const number = step.kind === 'pause' ? 0 : this.count(key);
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
        number,
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

  /** Acts on one key. Ctrl-C works at any time; the others only on a prompt, once it has been up for the key guard. */
  press(key: Exclude<StepKey, 'suspend'>, options: PressOptions = { guard: true }): void {
    if (key === 'interrupt') {
      this.stop();
      return;
    }
    const shown = this.queue[0];
    if (shown === undefined || (options.guard && this.now() - this.shownAt < KEY_GUARD_MS)) return;
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

  /** Numbers the steps of one test as they reach the gate; a new test starts at 1 and ends what `n` let through. */
  private count(key: string): number {
    if (this.current?.key !== key) {
      this.current = { key, count: 0 };
      if (this.released !== key) this.released = undefined;
    }
    this.current.count += 1;
    return this.current.count;
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
    this.shownAt = this.now();
    this.show?.(this.prompt());
  }

  /** The prompt for the step first in the queue and the steps of its test held beside it, or none. */
  private prompt(): StepPrompt | undefined {
    const [first, ...rest] = this.queue;
    if (first === undefined) return undefined;
    const numbered = ({ step, number }: Waiting): NumberedStep => ({ step, number });
    return { steps: [numbered(first), ...rest.filter((waiting) => samePrompt(waiting.step, first.step)).map(numbered)], help: this.help, holdSteps: this.holdSteps };
  }
}
