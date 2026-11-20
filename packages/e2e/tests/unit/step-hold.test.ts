import { describe, expect, it, vi } from 'vitest';
import { Deadline } from '@e2e-dev/core/lib/internal/time';
import { AttemptBudget, AttemptTimeout } from '@e2e-dev/core/lib/run/budget';
import { AttemptHolds } from '../../src/run/step-hold.ts';

const never = (): Promise<never> => new Promise<never>(() => {});

function attemptTimeout(timeoutMs: number, onMoved?: (remainingMs: number) => void): AttemptTimeout {
  return new AttemptTimeout(new AttemptBudget(new AbortController().signal, new Deadline(timeoutMs)), timeoutMs, onMoved);
}

describe('AttemptTimeout', () => {
  it('times the race out at once when set below the time already spent', async () => {
    const timeout = attemptTimeout(10_000);
    const body = timeout.race(never(), () => new Error('timed out'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const set = Date.now();
    timeout.set(10);
    await expect(body).rejects.toThrow('timed out');
    // Not at the 10 s the race started with.
    expect(Date.now() - set).toBeLessThan(1_000);
    expect(timeout.timeoutMs).toBe(10);
  });

  it('lets a raised race run past the timeout it started with', async () => {
    const timeout = attemptTimeout(30);
    timeout.set(5_000);
    const body = timeout.race(new Promise((resolve) => setTimeout(() => resolve('done'), 80)), () => new Error('timed out'));
    await expect(body).resolves.toBe('done');
  });

  it('refuses a change once the race settled, also from work a timeout left running, and tells the watchdog nothing', async () => {
    const onMoved = vi.fn();
    const timeout = attemptTimeout(10, onMoved);
    await expect(timeout.race(never(), () => new Error('timed out'))).rejects.toThrow('timed out');
    expect(timeout.set(60_000)).toBe(false);
    expect(onMoved).not.toHaveBeenCalled();
    expect(timeout.timeoutMs).toBe(10);

    const passed = attemptTimeout(5_000);
    await passed.race(Promise.resolve(), () => new Error('timed out'));
    expect(passed.set(60_000)).toBe(false);
    expect(passed.timeoutMs).toBe(5_000);
  });
});

describe('AttemptHolds', () => {
  it('times the body out at a hold that comes past the deadline, without asking', async () => {
    const signal = new AbortController().signal;
    const ask = vi.fn(never);
    const timeout = attemptTimeout(20);
    const holds = new AttemptHolds({ timeout, signal, ask, onResume: () => {} });
    const body = timeout.race(never(), () => new Error('timed out'));
    // Synchronous work blocks the event loop past the deadline, so its timer never fires.
    const end = Date.now() + 40;
    while (Date.now() < end) {}
    await holds.hold({ kind: 'step', api: 'app.open', label: '/' }, signal);
    await expect(body).rejects.toThrow('timed out');
    expect(ask).not.toHaveBeenCalled();
  });

  it('stops a clock test.setTimeout moved while screen.pause() waits, and runs it again from what was left', async () => {
    const signal = new AbortController().signal;
    const onMoved = vi.fn();
    const timeout = attemptTimeout(10_000, onMoved);
    // The pause waits twice as long as the lowered timeout.
    const holds = new AttemptHolds({ timeout, signal, ask: () => new Promise<void>((resolve) => setTimeout(resolve, 300)), onResume: () => {} });
    let leftAfterPause = -1;
    const body = timeout.race(
      (async () => {
        timeout.set(150);
        await holds.hold({ kind: 'pause', api: 'screen.pause', label: '' }, signal);
        leftAfterPause = timeout.budget.deadline.remaining();
        return 'resumed';
      })(),
      () => new Error('timed out'),
    );
    await expect(body).resolves.toBe('resumed');
    // The clock ran again on what was left of the 150 ms when the pause began, and told the watchdog.
    expect(leftAfterPause).toBeGreaterThan(0);
    expect(leftAfterPause).toBeLessThanOrEqual(150);
    expect(onMoved).toHaveBeenLastCalledWith(expect.any(Number));
    expect(onMoved.mock.lastCall![0]).toBeLessThanOrEqual(150);
  });

  it('moves a held clock by what test.setTimeout changed, and the release announces it', async () => {
    const signal = new AbortController().signal;
    let release: () => void = () => {};
    const ask = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const onMoved = vi.fn();
    const timeout = attemptTimeout(10_000, onMoved);
    const holds = new AttemptHolds({ timeout, signal, ask, onResume: () => {} });
    const held = holds.hold({ kind: 'step', api: 'app.open', label: '/' }, signal);
    // Held: the clock is stopped, so the change moves what the release hands back and announces nothing yet.
    timeout.set(60_000);
    expect(onMoved).not.toHaveBeenCalled();
    release();
    await held;
    expect(onMoved).toHaveBeenCalledTimes(1);
    expect(onMoved.mock.calls[0]?.[0]).toBeGreaterThan(59_000);
    expect(timeout.budget.deadline.remaining()).toBeGreaterThan(59_000);
    // Running: the phase's deadline moves at once, and the move is announced.
    timeout.set(30_000);
    expect(onMoved).toHaveBeenCalledTimes(2);
    expect(timeout.budget.deadline.remaining()).toBeLessThan(30_001);
  });
});
