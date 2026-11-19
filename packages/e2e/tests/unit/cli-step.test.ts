import { describe, expect, it } from 'vitest';
import { StepGate, stepKeyOf } from '../../src/cli/step.ts';
import type { HeldStep, StepHoldContext, StepPrompt } from '../../src/run/step-hold.ts';

/** How long a prompt ignores keys after it appears. */
const KEY_GUARD_MS = 150;

function step(label: string, testId = 'checkout', target = 'web'): HeldStep {
  return { kind: 'step', target, testId, agent: 'default', repeat: 0, title: testId, api: 'app.open', label };
}

function pause(testId = 'checkout', target = 'web'): HeldStep {
  return { kind: 'pause', target, testId, agent: 'default', repeat: 0, title: testId, api: 'screen.pause', label: '' };
}

/** A gate on a clock the test moves, recording what it showed and whether it asked to stop. */
function gate(holdSteps = true) {
  let now = 0;
  const shown: (StepPrompt | undefined)[] = [];
  let stops = 0;
  const subject = new StepGate(
    () => {
      stops += 1;
    },
    { now: () => now, holdSteps },
  );
  const context = (signal = new AbortController().signal): StepHoldContext => ({ signal, show: (prompt) => shown.push(prompt), readScreen: () => Promise.resolve(undefined) });
  /** Holds `held` and reports, after the microtasks drain, whether it was let through. */
  const hold = (held: HeldStep, signal?: AbortSignal) => {
    let released = false;
    void subject.beforeStep(held, context(signal)).then(() => {
      released = true;
    });
    return { released: async () => { await Promise.resolve(); await Promise.resolve(); return released; } };
  };
  return {
    gate: subject,
    hold,
    /** What the prompt shows now: each held step's number and label, or nothing. */
    showing: () => shown.at(-1)?.steps.map((held) => `${held.number} ${held.step.label}`).join(' + '),
    shown,
    stops: () => stops,
    later: (ms = KEY_GUARD_MS) => {
      now += ms;
    },
  };
}

describe('stepKeyOf', () => {
  it('maps the watch-style keys, Escape to stop, and the control keys raw mode delivers', () => {
    expect(stepKeyOf({ name: 'return', ctrl: false })).toBe('continue');
    expect(stepKeyOf({ name: 'n', ctrl: false })).toBe('test');
    expect(stepKeyOf({ name: 'a', ctrl: false })).toBe('rest');
    expect(stepKeyOf({ name: 'h', ctrl: false })).toBe('help');
    expect(stepKeyOf({ name: 'q', ctrl: false })).toBe('stop');
    expect(stepKeyOf({ name: 'escape', ctrl: false })).toBe('stop');
    expect(stepKeyOf({ name: 'c', ctrl: true })).toBe('interrupt');
    expect(stepKeyOf({ name: 'z', ctrl: true })).toBe('suspend');
    expect(stepKeyOf({ name: 'c', ctrl: false })).toBeUndefined();
  });
});

describe('StepGate', () => {
  it('runs the first step of the run at once and holds the next until c, then takes the prompt down', async () => {
    const { gate: subject, hold, showing, shown, later } = gate();
    expect(await hold(step('/')).released()).toBe(true);
    expect(shown).toEqual([]);
    const second = hold(step('/cart'));
    expect(await second.released()).toBe(false);
    expect(showing()).toBe('2 /cart');
    later();
    subject.press('continue');
    expect(await second.released()).toBe(true);
    expect(showing()).toBeUndefined();
  });

  it('ignores a key pressed before the prompt has been up for the guard', async () => {
    const { gate: subject, hold, later } = gate();
    await hold(step('/')).released();
    const held = hold(step('/cart'));
    later(KEY_GUARD_MS - 1);
    subject.press('continue');
    expect(await held.released()).toBe(false);
    later(1);
    subject.press('continue');
    expect(await held.released()).toBe(true);
  });

  it('asks to stop on Ctrl-C at once, guard or no prompt, and on q only at a prompt', async () => {
    const { gate: subject, hold, stops, later } = gate();
    subject.press('interrupt');
    expect(stops()).toBe(1);
    subject.press('stop');
    expect(stops()).toBe(1);
    await hold(step('/')).released();
    hold(step('/cart'));
    subject.press('interrupt');
    expect(stops()).toBe(2);
    later();
    subject.press('stop');
    expect(stops()).toBe(3);
  });

  it('shows steps held together in one prompt and runs them on one key, so a wait never outlives its action', async () => {
    const { gate: subject, hold, showing, later } = gate();
    await hold(step('/')).released();
    const waits = hold(step('/api/orders'));
    expect(showing()).toBe('2 /api/orders');
    const acts = hold(step('Place order'));
    expect(showing()).toBe('2 /api/orders + 3 Place order');
    later();
    subject.press('continue');
    expect([await waits.released(), await acts.released()]).toEqual([true, true]);
    expect(showing()).toBeUndefined();
  });

  it('lists every key on h until h again, and keeps it for the next prompt', async () => {
    const { gate: subject, hold, shown, later } = gate();
    await hold(step('/')).released();
    const held = hold(step('/cart'));
    later();
    subject.press('help');
    expect(await held.released()).toBe(false);
    expect(shown.at(-1)).toMatchObject({ steps: [{ number: 2 }], help: true });
    subject.press('continue');
    hold(step('/pay'));
    expect(shown.at(-1)).toMatchObject({ steps: [{ number: 3 }], help: true });
    later();
    subject.press('help');
    expect(shown.at(-1)).toMatchObject({ steps: [{ number: 3 }], help: false });
  });

  it('lets the rest of one test through on n, and holds again at the next test or target', async () => {
    const { gate: subject, hold, later } = gate();
    await hold(step('/')).released();
    hold(step('/cart'));
    later();
    subject.press('test');
    expect(await hold(step('/pay')).released()).toBe(true);
    expect(await hold(step('/', 'checkout', 'mobile')).released()).toBe(false);
  });

  it('lets every step through after a', async () => {
    const { gate: subject, hold, later } = gate();
    await hold(step('/')).released();
    const held = hold(step('/cart'));
    later();
    subject.press('rest');
    expect(await held.released()).toBe(true);
    expect(await hold(step('/', 'profile')).released()).toBe(true);
  });

  it('never prompts for a hold that ended before it arrived', async () => {
    const { hold, shown } = gate();
    await hold(step('/')).released();
    const ended = new AbortController();
    ended.abort();
    expect(await hold(step('/late'), ended.signal).released()).toBe(true);
    expect(shown).toEqual([]);
  });

  it('drops a prompt whose hold ended and shows the next one', async () => {
    const { hold, showing } = gate();
    await hold(step('/')).released();
    const ended = new AbortController();
    hold(step('/gone'), ended.signal);
    hold(step('/next'));
    ended.abort();
    expect(showing()).toBe('3 /next');
  });

  it('waits at a pause that comes before any step until Enter', async () => {
    const { gate: subject, hold, shown, later } = gate();
    const paused = hold(pause());
    expect(await paused.released()).toBe(false);
    expect(shown.at(-1)?.steps.map((held) => held.step.kind)).toEqual(['pause']);
    later();
    subject.press('continue');
    expect(await paused.released()).toBe(true);
    expect(shown.at(-1)).toBeUndefined();
  });

  it('holds the first step after a pause that came first, as step 1, since the pause already showed the app', async () => {
    const { gate: subject, hold, showing, later } = gate();
    const paused = hold(pause());
    later();
    subject.press('continue');
    expect(await paused.released()).toBe(true);
    const first = hold(step('/one'));
    expect(await first.released()).toBe(false);
    expect(showing()).toBe('1 /one');
    later();
    subject.press('continue');
    expect(await first.released()).toBe(true);
    hold(step('/two'));
    expect(showing()).toBe('2 /two');
  });

  it('shows pauses from several tests one at a time, oldest first', async () => {
    const { gate: subject, hold, shown, later } = gate();
    const first = hold(pause('checkout'));
    const second = hold(pause('profile'));
    expect(shown.at(-1)?.steps.map((held) => held.step.testId)).toEqual(['checkout']);
    later();
    subject.press('continue');
    expect(await first.released()).toBe(true);
    expect(await second.released()).toBe(false);
    expect(shown.at(-1)?.steps.map((held) => held.step.testId)).toEqual(['profile']);
    later();
    subject.press('continue');
    expect(await second.released()).toBe(true);
  });

  it('shows a pause on a separate prompt, without a step number, and keeps numbering the steps', async () => {
    const { gate: subject, hold, showing, later } = gate();
    await hold(step('/')).released();
    const paused = hold(pause());
    expect(showing()).toBe('0 ');
    later();
    subject.press('continue');
    expect(await paused.released()).toBe(true);
    hold(step('/cart'));
    expect(showing()).toBe('2 /cart');
  });

  it('waits at every pause in a run without --step, whichever key resumed the one before', async () => {
    const { gate: subject, hold, shown, later } = gate(false);
    const first = hold(pause());
    expect(shown.at(-1)).toMatchObject({ holdSteps: false });
    later();
    subject.press('rest');
    expect(await first.released()).toBe(true);
    const second = hold(pause());
    expect(await second.released()).toBe(false);
    later();
    subject.press('test');
    expect(await second.released()).toBe(true);
    expect(await hold(pause()).released()).toBe(false);
  });

  it('resumes only the test whose pause is shown on a, and keeps the pause of another test waiting behind it', async () => {
    const { gate: subject, hold, shown, later } = gate(false);
    const first = hold(pause('checkout'));
    const second = hold(pause('profile'));
    later();
    subject.press('rest');
    expect(await first.released()).toBe(true);
    expect(await second.released()).toBe(false);
    expect(shown.at(-1)?.steps.map((held) => held.step.testId)).toEqual(['profile']);
  });

  it('stops holding steps after a at a step, but still waits at a later pause', async () => {
    const { gate: subject, hold, later } = gate();
    await hold(step('/')).released();
    hold(step('/cart'));
    later();
    subject.press('rest');
    expect(await hold(step('/pay')).released()).toBe(true);
    const paused = hold(pause());
    expect(await paused.released()).toBe(false);
    later();
    subject.press('continue');
    expect(await paused.released()).toBe(true);
    expect(await hold(step('/done')).released()).toBe(true);
  });

  it('stops holding the steps of the test after n at a step, but still waits at a later pause of that test', async () => {
    const { gate: subject, hold, later } = gate();
    await hold(step('/')).released();
    hold(step('/cart'));
    later();
    subject.press('test');
    expect(await hold(step('/pay')).released()).toBe(true);
    expect(await hold(pause()).released()).toBe(false);
  });

  it('resumes the paused test on n or a in a stepped run, stops holding steps as at a step, and waits at the next pause', async () => {
    const { gate: subject, hold, shown, later } = gate();
    await hold(step('/')).released();
    const paused = hold(pause());
    expect(shown.at(-1)).toMatchObject({ holdSteps: true });
    later();
    subject.press('test');
    expect(await paused.released()).toBe(true);
    expect(await hold(step('/cart')).released()).toBe(true);
    const next = hold(pause());
    expect(await next.released()).toBe(false);
    later();
    subject.press('rest');
    expect(await next.released()).toBe(true);
    expect(await hold(step('/', 'profile')).released()).toBe(true);
    expect(await hold(pause('profile')).released()).toBe(false);
  });
});
