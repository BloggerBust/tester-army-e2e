/** The clock's argument grammar, Playwright's own, and the step labels, which run on raw arguments before any check. */
import { describe, expect, it } from 'vitest';
import { clockInstallLabel, clockTicks, clockTicksLabel, clockTime, clockTimeLabel, translateClockError } from '../../src/clock.ts';

describe('clock arguments', () => {
  it('reads ticks as Playwright does: milliseconds, or ss, mm:ss, hh:mm:ss with fields under 60', () => {
    expect(clockTicks('api', 0)).toBe(0);
    expect(clockTicks('api', 1.5)).toBe(1.5);
    expect(clockTicks('api', '5')).toBe(5_000);
    expect(clockTicks('api', '01:30')).toBe(90_000);
    expect(clockTicks('api', '02:00:01')).toBe(7_201_000);
    for (const refused of [-1, Number.NaN, Infinity, '', '1:30', '00:60', '60', '01:02:03:04', '1h', null, undefined]) {
      expect(() => clockTicks('api', refused)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    }
  });

  it('reads a time as epoch milliseconds, a string Date parses, or a valid Date', () => {
    const at = Date.parse('2024-02-02T08:00:00Z');
    expect(clockTime('api', at)).toBe(at);
    expect(clockTime('api', -1)).toBe(-1);
    expect(clockTime('api', '2024-02-02T08:00:00Z')).toBe(at);
    expect(clockTime('api', new Date(at))).toBe(at);
    // 1e16 is past the range a Date holds, which Playwright refuses as an invalid date.
    for (const refused of ['', ' ', 'soon', new Date(Number.NaN), Number.NaN, Infinity, 1e16, {}, null]) {
      expect(() => clockTime('api', refused)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    }
  });

  it('labels a valid argument and leaves an invalid one blank instead of throwing', () => {
    expect(clockTimeLabel(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(clockTicksLabel(250)).toBe('250ms');
    expect(clockTicksLabel('01:30')).toBe('01:30');
    expect(clockInstallLabel({ time: '2024-02-02T08:00:00Z' })).toBe('2024-02-02T08:00:00.000Z');
    expect(clockInstallLabel(undefined)).toBe('');
    expect(clockTimeLabel(1e16)).toBe('');
    for (const raw of [new Date(Number.NaN), 'soon', -1, Symbol('x'), {}]) {
      expect(clockTimeLabel(raw)).toBe(typeof raw === 'number' ? '1969-12-31T23:59:59.999Z' : '');
      expect(clockTicksLabel(raw)).toBe('');
    }
  });
});

describe('clock errors', () => {
  const failed = (text: string) => new Error(text);

  it('blames a page timer only on a call that runs timers, and keeps the page\'s first line', () => {
    const thrown = translateClockError(failed('clock.runFor: Error: boom\n    at ClockController._callFirstTimer'), 'browser.clock.runFor', 'runFor');
    expect(thrown).toMatchObject({ code: 'EVALUATE_FAILED', message: 'browser.clock.runFor: a page timer threw: Error: boom' });
    expect(translateClockError(failed('clock.install: something odd'), 'browser.clock.install', 'install')).toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it('reads pauseAt before the current time as the test\'s argument', () => {
    expect(translateClockError(failed('clock.pauseAt: Error: Cannot fast-forward to the past'), 'browser.clock.pauseAt', 'pauseAt'))
      .toMatchObject({ code: 'INVALID_ARGUMENT', message: "browser.clock.pauseAt: the time is before the clock's current time" });
  });

  it('leaves a closed, crashed, or disconnected browser to the engine', () => {
    for (const text of [
      'clock.runFor: Target page, context or browser has been closed',
      'clock.runFor: Page crashed',
      'clock.fastForward: Protocol error (Page.addScriptToEvaluateOnNewDocument): Session closed',
      'clock.pauseAt: Connection closed',
    ]) {
      expect(translateClockError(failed(text), 'browser.clock.runFor', 'runFor')).toMatchObject({ code: 'ENGINE_FAILURE' });
    }
  });

  it('blames the page for a timer error whose message reads like a closed browser or a time in the past', () => {
    for (const thrown of ['Error: Session closed', 'Error: WebSocket connection closed', 'Error: Protocol error: bad frame', 'Error: Cannot fast-forward to the past']) {
      expect(translateClockError(failed(`clock.runFor: ${thrown}\n    at ClockController._callFirstTimer`), 'browser.clock.runFor', 'runFor'))
        .toMatchObject({ code: 'EVALUATE_FAILED', message: `browser.clock.runFor: a page timer threw: ${thrown}` });
    }
  });
});
