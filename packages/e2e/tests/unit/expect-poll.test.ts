import { describe, expect as vexpect, it, vi } from 'vitest';
import { z } from 'zod';
import { currentAttempt, publishAttempt } from '@e2e-dev/core/lib/expect/attempt';
import { expect as e2eExpect } from '../../src/expect/index.ts';
import { currentPollScope, insidePollRead, pollLineage, pollRead, pollReadSignal, PollScope, runInPollScope } from '@e2e-dev/core/lib/expect/poll-scope';
import { isAbandonedRejection } from '@e2e-dev/core/lib/internal/abandoned';
import { pollScopesBrand } from '@e2e-dev/core/lib/internal/brands';
import { realmSlot } from '@e2e-dev/core/lib/internal/realm-slot';
import { SoftFailures } from '@e2e-dev/core/lib/expect/soft';
import { ConfigurationError, TestError } from '@e2e-dev/core/lib/internal/errors';
import { Deadline } from '@e2e-dev/core/lib/internal/time';
import { AttemptBudget } from '@e2e-dev/core/lib/run/budget';
import { useFakeTime } from '../helpers/fake-time.ts';

useFakeTime();

/** Publishes a fake attempt for one test; `end()` clears it. */
function attempt(options: { assertionTimeout: number; deadlineMs: number }) {
  const cancel = new AbortController();
  const end = new AbortController();
  const budget = new AttemptBudget(cancel.signal, new Deadline(options.deadlineMs));
  publishAttempt(
    {
      attemptId: 'attempt',
      owner: 'suite',
      testKind: 'test',
      assertionTimeout: options.assertionTimeout,
      budget,
      soft: new SoftFailures(),
    },
    end.signal,
  );
  return { budget, cancel: () => cancel.abort(), end: () => end.abort() };
}

async function failsWith(run: () => Promise<void>, ...patterns: RegExp[]): Promise<string> {
  try {
    await run();
  } catch (error) {
    vexpect(error).toBeInstanceOf(TestError);
    vexpect((error as TestError).code).toBe('ASSERTION_FAILED');
    for (const pattern of patterns) vexpect((error as TestError).message).toMatch(pattern);
    return (error as TestError).message;
  }
  throw new Error('expected the poll to time out');
}

/** A read whose value settles after `settleAfter` samples. */
function settling<T>(before: T, after: T, settleAfter: number): { read: () => T; reads: () => number } {
  let reads = 0;
  return {
    read: () => {
      reads += 1;
      return reads > settleAfter ? after : before;
    },
    reads: () => reads,
  };
}

describe('expect.poll', () => {
  it('passes once the value settles and stops reading', async () => {
    const status = settling('running', 'done', 3);
    await e2eExpect.poll(status.read, { intervals: [5] }).toBe('done');
    vexpect(status.reads()).toBe(4);
  });

  it('accepts an asynchronous read', async () => {
    const count = settling(0, 2, 2);
    await e2eExpect.poll(async () => count.read(), { intervals: [5] }).toBeGreaterThan(1);
    vexpect(count.reads()).toBe(3);
  });

  it('times out with the last value in the message', async () => {
    const message = await failsWith(
      () => e2eExpect.poll(() => 'running', { timeout: 100, intervals: [10] }).toBe('done'),
      /^expect\.poll\(\.\.\.\)\.toBe\(\.\.\.\) timed out after 100 ms\n/,
      /last: expected "running" to be "done"$/,
    );
    vexpect(message.split('\n')).toHaveLength(2);
  });

  it('.not flips the check', async () => {
    const status = settling('running', 'done', 2);
    await e2eExpect.poll(status.read, { intervals: [5] }).not.toBe('running');
    vexpect(status.reads()).toBe(3);
    await failsWith(
      () => e2eExpect.poll(() => 'running', { timeout: 60, intervals: [10] }).not.toBe('running'),
      /^expect\.poll\(\.\.\.\)\.not\.toBe\(\.\.\.\) timed out after 60 ms/,
      /last: expected "running" not to be "running"/,
    );
  });

  it('toBeOK re-reads the response until its status is 2xx', async () => {
    const reply = (status: number) => ({ url: 'https://api.test/jobs/1', status, headers: {}, body: async () => Buffer.from(''), json: async <T>() => ({}) as T, text: async () => '' });
    const pending = settling(reply(503), reply(200), 2);
    await vexpect(e2eExpect.poll(pending.read, { intervals: [5] }).toBeOK()).resolves.toBeUndefined();
    vexpect(pending.reads()).toBe(3);
    await failsWith(
      () => e2eExpect.poll(() => reply(503), { timeout: 60, intervals: [10] }).toBeOK(),
      /^expect\.poll\(\.\.\.\)\.toBeOK\(\.\.\.\) timed out after 60 ms/,
      /last: expected a 2xx status, got 503 from https:\/\/api\.test\/jobs\/1/,
    );
  });

  it('places the message option between the matcher line and the last sample', async () => {
    const message = await failsWith(
      () =>
        e2eExpect
          .poll(() => 'running', { timeout: 60, intervals: [10], message: 'the batch never finished' })
          .toBe('done'),
    );
    vexpect(message.split('\n')).toEqual([
      'expect.poll(...).toBe(...) timed out after 60 ms',
      'the batch never finished',
      'last: expected "running" to be "done"',
    ]);
  });

  it('keeps polling through a throwing read and reports its error at the deadline', async () => {
    let reads = 0;
    await e2eExpect
      .poll(() => {
        reads += 1;
        if (reads < 3) throw new Error('connection refused');
        return 'done';
      }, { intervals: [5] })
      .toBe('done');
    vexpect(reads).toBe(3);

    let failures = 0;
    await failsWith(
      () =>
        e2eExpect
          .poll(
            async (): Promise<string> => {
              failures += 1;
              throw new Error('connection refused');
            },
            { timeout: 80, intervals: [10] },
          )
          .toBe('done'),
      /last: connection refused$/,
    );
    vexpect(failures).toBeGreaterThan(1);
  });

  it('bounds a hung read by the deadline', async () => {
    const started = Date.now();
    await failsWith(
      () => e2eExpect.poll(() => new Promise<string>(() => {}), { timeout: 100 }).toBe('done'),
      /timed out after 100 ms/,
      /last: no read completed$/,
    );
    vexpect(Date.now() - started).toBeLessThan(1000);
  });

  it('keeps the last completed sample when a later read hangs', async () => {
    let reads = 0;
    await failsWith(
      () =>
        e2eExpect
          .poll(() => {
            reads += 1;
            return reads === 1 ? 'running' : new Promise<string>(() => {});
          }, { timeout: 100, intervals: [5] })
          .toBe('done'),
      /last: expected "running" to be "done"$/,
    );
    vexpect(reads).toBe(2);
  });

  it('honors the interval between samples', async () => {
    let reads = 0;
    await failsWith(() =>
      e2eExpect
        .poll(() => {
          reads += 1;
          return 'running';
        }, { timeout: 200, intervals: [50] })
        .toBe('done'),
    );
    vexpect(reads).toBeGreaterThanOrEqual(3);
    vexpect(reads).toBeLessThanOrEqual(6);
  });

  it('uses each interval in order and repeats the last interval', async () => {
    const start = Date.now();
    const reads: number[] = [];
    await e2eExpect.poll(() => reads.push(Date.now() - start), { intervals: [10, 20, 40] }).toBe(5);
    vexpect(reads).toEqual([0, 10, 30, 70, 110]);
  });

  it('uses the default pauses in order and repeats the last pause', async () => {
    const start = Date.now();
    const reads: number[] = [];
    await e2eExpect.poll(() => reads.push(Date.now() - start)).toBe(6);
    vexpect(reads).toEqual([0, 100, 350, 850, 1850, 2850]);
  });

  it('ignores a synchronous read that returns after the deadline', async () => {
    await failsWith(
      () => e2eExpect.poll(() => {
        vi.advanceTimersByTime(60);
        return true;
      }, { timeout: 10 }).toBe(true),
      /timed out after 10 ms\nlast: no read completed$/,
    );
  });

  it('uses the deprecated interval for each pause and warns once across two polls', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      for (let i = 0; i < 2; i++) {
        const start = Date.now();
        const reads: number[] = [];
        await e2eExpect.poll(() => reads.push(Date.now() - start), { interval: 50 }).toBe(3);
        vexpect(reads).toEqual([0, 50, 100]);
      }
      vexpect(stderr).toHaveBeenCalledExactlyOnceWith(
        'e2e: [warning] expect.poll interval is deprecated. Pass intervals: [<ms>].\n',
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('refuses interval and intervals together before reading', () => {
    let reads = 0;
    const options = { timeout: 100, interval: 10, intervals: [20] };
    vexpect(() => e2eExpect.poll(() => ++reads, options).toBe(1)).toThrowError(
      vexpect.objectContaining({
        code: 'INVALID_CONFIG',
        message: 'expect.poll cannot take both interval and intervals',
      }),
    );
    vexpect(reads).toBe(0);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses an invalid deprecated interval of %s', (interval) => {
    vexpect(() => e2eExpect.poll(() => 1, { interval })).toThrowError(vexpect.objectContaining({
      code: 'INVALID_CONFIG',
      message: `expect.poll interval must be a finite number of milliseconds above 0; got ${String(interval)}`,
    }));
  });

  it('refuses a non-plain poll options object', () => {
    vexpect(() => Reflect.apply(e2eExpect.poll, undefined, [() => 1, null])).toThrow(
      vexpect.objectContaining({ code: 'INVALID_CONFIG', message: 'expect.poll options must be a plain object' }),
    );
  });

  it('names the nearest poll option for an unknown key', () => {
    vexpect(() => Reflect.apply(e2eExpect.poll, undefined, [() => 1, { tiemout: 100 }])).toThrow(
      vexpect.objectContaining({ code: 'INVALID_CONFIG', message: 'expect.poll options has unknown key "tiemout"; did you mean "timeout"?' }),
    );
  });

  it.each([[], [0], [-1], [Number.NaN], [10, Number.POSITIVE_INFINITY]].map((intervals) => ({ intervals })))('refuses invalid intervals $intervals before reading', ({ intervals }) => {
    vexpect(() => e2eExpect.poll(() => 1, { intervals })).toThrowError(
      vexpect.objectContaining({ code: 'INVALID_CONFIG', message: vexpect.stringContaining('expect.poll intervals') }),
    );
  });

  it('refuses a fractional pause in intervals', () => {
    vexpect(() => e2eExpect.poll(() => true, { intervals: [0.5] })).toThrow(vexpect.objectContaining({
      code: 'INVALID_CONFIG',
      message: 'expect.poll intervals[0] must be a positive safe integer of milliseconds, got 0.5',
    }));
  });

  it('runs every value matcher', async () => {
    const rows = settling<readonly { title: string }[]>([], [{ title: 'a' }, { title: 'b' }], 1);
    await e2eExpect.poll(rows.read, { intervals: [5] }).toEqual([{ title: 'a' }, { title: 'b' }]);
    await e2eExpect.poll(rows.read, { intervals: [5] }).toContain({ title: 'b' });
    await e2eExpect.poll(() => rows.read().length, { intervals: [5] }).toBeGreaterThan(1);
    await e2eExpect.poll(() => 'order #42', { intervals: [5] }).toMatch(/#\d+/);
    await e2eExpect.poll(() => null, { intervals: [5] }).toBeNull();
    await e2eExpect.poll(() => undefined, { intervals: [5] }).toBeUndefined();
    await e2eExpect.poll(() => 0, { intervals: [5] }).toBeFalsy();
    await e2eExpect.poll(() => 1, { intervals: [5] }).toBeTruthy();
    await e2eExpect.poll(() => 'x', { intervals: [5] }).toBeDefined();
    await e2eExpect.poll(() => 1, { intervals: [5] }).toBeLessThan(2);
    await e2eExpect.poll(rows.read, { intervals: [5] }).toMatchObject([{ title: 'a' }, {}]);
    await e2eExpect.poll(rows.read, { intervals: [5] }).toHaveLength(2);
    await e2eExpect.poll(rows.read, { intervals: [5] }).toHaveProperty('1.title', 'b');
    await e2eExpect.poll(rows.read, { intervals: [5] }).toHaveProperty([0, 'title']);
    await e2eExpect.poll(rows.read, { intervals: [5] }).toEqual(e2eExpect.arrayContaining([{ title: e2eExpect.any(String) }]));
  });

  it('polls the new matchers until they hold and reports their last failure', async () => {
    const rows = settling<string[]>(['a'], ['a', 'b'], 2);
    await e2eExpect.poll(rows.read, { intervals: [5] }).toHaveLength(2);
    vexpect(rows.reads()).toBe(3);
    await failsWith(
      () => e2eExpect.poll(() => ({ status: 'running' }), { timeout: 60, intervals: [10] }).toHaveProperty('status', 'done'),
      /^expect\.poll\(\.\.\.\)\.toHaveProperty\(\.\.\.\) timed out after 60 ms/,
      /last: expected property "status" of {"status":"running"} to equal "done", got "running"/,
    );
    await failsWith(
      () => e2eExpect.poll(() => ({ a: 1 }), { timeout: 60, intervals: [10] }).not.toMatchObject({ a: 1 }),
      /last: expected {"a":1} not to match object {"a":1}/,
    );
  });

  it('treats a matcher type complaint as not yet, like any other failing sample', async () => {
    const value = settling<unknown>(42, 'hello world', 1);
    await e2eExpect.poll(value.read, { intervals: [5] }).toContain('world');
    vexpect(value.reads()).toBe(2);
  });

  it('a negated global regexp never passes on an unchanged matching value', async () => {
    await failsWith(
      () => e2eExpect.poll(() => 'done', { timeout: 60, intervals: [5] }).not.toMatch(/done/g),
      /last: expected "done" not to match/,
    );
  });

  it('refuses a timeout that could never expire, before the first read', () => {
    const invalid = (run: () => unknown, pattern: RegExp): void => {
      try {
        run();
      } catch (error) {
        vexpect(error).toBeInstanceOf(ConfigurationError);
        vexpect((error as ConfigurationError).code).toBe('INVALID_CONFIG');
        vexpect((error as ConfigurationError).message).toMatch(pattern);
        return;
      }
      throw new Error('expected expect.poll to refuse the option');
    };
    invalid(() => e2eExpect.poll(() => 1, { timeout: Number.NaN }), /timeout.*got NaN/);
    invalid(() => e2eExpect.poll(() => 1, { timeout: Number.POSITIVE_INFINITY }), /timeout.*got Infinity/);
    invalid(() => e2eExpect.poll(() => 1, { timeout: -1 }), /timeout.*got -1/);
    e2eExpect.poll(() => 1, { timeout: 0, intervals: [1] });
  });

  it('refuses timeout 0 outside an attempt, where no test deadline bounds it', async () => {
    await vexpect(e2eExpect.poll(() => 'running', { timeout: 0 }).toBe('done')).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: vexpect.stringContaining('runs only inside a test'),
    });
  });

  describe('inside an attempt', () => {
    it('defaults the timeout to the attempt assertionTimeout until the attempt ends', async () => {
      const live = attempt({ assertionTimeout: 80, deadlineMs: 10_000 });
      try {
        await failsWith(
          () => e2eExpect.poll(() => 'running', { intervals: [10] }).toBe('done'),
          /timed out after 80 ms/,
        );
      } finally {
        live.end();
      }
      vexpect(currentAttempt()).toBeUndefined();
    });

    it('caps the poll at the attempt deadline', async () => {
      const live = attempt({ assertionTimeout: 5000, deadlineMs: 80 });
      try {
        const started = Date.now();
        await failsWith(
          () => e2eExpect.poll(() => 'running', { timeout: 15_000, intervals: [10] }).toBe('done'),
          /stopped at the attempt deadline after \d+ ms/,
          /last: expected "running" to be "done"/,
        );
        vexpect(Date.now() - started).toBeLessThan(1000);
      } finally {
        live.end();
      }
    });

    it('polls with timeout 0 past the assertion timeout, until the attempt deadline', async () => {
      const live = attempt({ assertionTimeout: 20, deadlineMs: 150 });
      try {
        const started = Date.now();
        await failsWith(
          () => e2eExpect.poll(() => 'running', { timeout: 0, intervals: [10] }).toBe('done'),
          /stopped at the attempt deadline after \d+ ms/,
        );
        vexpect(Date.now() - started).toBeGreaterThanOrEqual(140);
      } finally {
        live.end();
      }
    });

    it('stops reading the moment the attempt is cancelled', async () => {
      const live = attempt({ assertionTimeout: 5000, deadlineMs: 10_000 });
      let reads = 0;
      try {
        const poll = e2eExpect
          .poll(() => {
            reads += 1;
            return 'running';
          }, { timeout: 15_000, intervals: [5] })
          .toBe('done');
        setTimeout(live.cancel, 30);
        await vexpect(poll).rejects.toMatchObject({ code: 'CANCELLED', category: 'infrastructure' });
        const readsAtCancel = reads;
        await new Promise((resolve) => setTimeout(resolve, 50));
        vexpect(reads).toBe(readsAtCancel);
      } finally {
        live.end();
      }
    });

    it('cuts a read in flight when the attempt is cancelled', async () => {
      const live = attempt({ assertionTimeout: 5000, deadlineMs: 10_000 });
      try {
        const poll = e2eExpect.poll(() => new Promise<string>(() => {}), { timeout: 15_000 }).toBe('done');
        setTimeout(live.cancel, 20);
        await vexpect(poll).rejects.toMatchObject({ code: 'CANCELLED' });
      } finally {
        live.end();
      }
    });

    it('refuses a second live attempt in the same process', () => {
      const live = attempt({ assertionTimeout: 5000, deadlineMs: 10_000 });
      try {
        vexpect(() => attempt({ assertionTimeout: 5000, deadlineMs: 10_000 })).toThrowError(
          /attempt attempt started while attempt attempt was still running/,
        );
      } finally {
        live.end();
      }
      const next = attempt({ assertionTimeout: 5000, deadlineMs: 10_000 });
      next.end();
      vexpect(currentAttempt()).toBeUndefined();
    });
  });
});

describe('expect.poll in a poll scope', () => {
  it('keeps the active scope of a runner that cannot mark poll reads', () => {
    const slot = realmSlot<unknown>(pollScopesBrand);
    const previous = slot.get(globalThis);
    const scope = new PollScope('the test body');
    const olderRunner = { current: () => scope };
    slot.set(globalThis, olderRunner);
    try {
      pollRead(() => {
        vexpect(currentPollScope()).toBe(scope);
        vexpect(insidePollRead()).toBe(false);
        vexpect(pollReadSignal()).toBeUndefined();
      }, new AbortController().signal);
      vexpect(slot.get(globalThis)).toBe(olderRunner);
    } finally {
      if (previous === undefined) slot.delete(globalThis);
      else slot.set(globalThis, previous);
    }
  });

  it('makes the cutoff available inside a standalone read without a runner scope', async () => {
    const slot = realmSlot<unknown>(pollScopesBrand);
    const previous = slot.get(globalThis);
    const { signal } = new AbortController();
    slot.delete(globalThis);
    try {
      await pollRead(async () => {
        await Promise.resolve();
        vexpect(insidePollRead()).toBe(true);
        vexpect(pollReadSignal()).toBe(signal);
      }, signal);
    } finally {
      if (previous === undefined) slot.delete(globalThis);
      else slot.set(globalThis, previous);
    }
  });

  it('marks a read from an older expect copy that supplies no signal', () => {
    const slot = realmSlot<{ read<T>(run: () => T): T }>(pollScopesBrand);
    runInPollScope(new PollScope('the test body'), () => {
      const runner = slot.get(globalThis);
      if (runner === undefined) throw new Error('expected the running scope');
      runner.read(() => vexpect(insidePollRead()).toBe(true));
    });
  });

  it('keeps the same cancellation signal inside a read until the phase changes', () => {
    const phase = new AbortController();
    const read = new AbortController();
    const budget = new AttemptBudget(phase.signal, new Deadline(100));
    pollRead(() => {
      const first = budget.signal;
      vexpect(budget.signal).toBe(first);
      budget.enter(phase.signal, 200);
      const second = budget.signal;
      vexpect(second).not.toBe(first);
      vexpect(budget.signal).toBe(second);
    }, read.signal);
  });

  /** A read that counts its calls and never passes `toBe('done')`. */
  function counting(): { read: () => string; reads: () => number } {
    let reads = 0;
    return {
      read: () => {
        reads += 1;
        return 'running';
      },
      reads: () => reads,
    };
  }

  async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => undefined,
      (cause: unknown) => cause,
    );
  }

  it('fails the phase that returned before its poll finished, at the line of the call, and cancels it', async () => {
    const scope = new PollScope('the test body');
    const status = counting();
    const poll = runInPollScope(scope, () => e2eExpect.poll(status.read, { timeout: 5000, intervals: [5] }).toBe('done'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const error = scope.close();
    vexpect(error).toBeInstanceOf(TestError);
    vexpect(error?.code).toBe('STEP_NOT_AWAITED');
    vexpect(error?.message).toBe(
      'the test body returned before expect.poll(...).toBe(...) finished; put `await` in front of every expect.poll matcher and toPass call',
    );
    vexpect(error?.stack).toContain('expect-poll.test.ts');
    const rejection = await rejectionOf(poll);
    vexpect(rejection).toMatchObject({ code: 'CANCELLED' });
    vexpect(isAbandonedRejection(rejection)).toBe(true);
    const readsAtClose = status.reads();
    await new Promise((resolve) => setTimeout(resolve, 30));
    vexpect(status.reads()).toBe(readsAtClose);
  });

  it('names one poll and counts the rest, negation included', async () => {
    const scope = new PollScope('the afterEach hook');
    const polls = runInPollScope(scope, () => [
      e2eExpect.poll(() => 1, { timeout: 5000 }).not.toBe(1),
      e2eExpect.poll(() => 1, { timeout: 5000 }).toBe(2),
    ]);
    const error = scope.close();
    vexpect(error?.message).toMatch(/^the afterEach hook returned before expect\.poll\(\.\.\.\)\.not\.toBe\(\.\.\.\) and 1 more finished/);
    vexpect(scope.close()).toBeUndefined();
    await Promise.allSettled(polls);
  });

  it('a poll that would have passed still fails its phase when not awaited', async () => {
    const scope = new PollScope('the test body');
    const poll = runInPollScope(scope, () => e2eExpect.poll(settling('running', 'done', 3).read, { intervals: [20] }).toBe('done'));
    vexpect(scope.close()?.code).toBe('STEP_NOT_AWAITED');
    await vexpect(poll).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('closes quietly when every poll was awaited, whatever its outcome', async () => {
    const scope = new PollScope('the test body');
    await runInPollScope(scope, async () => {
      await e2eExpect.poll(settling('running', 'done', 1).read, { intervals: [5] }).toBe('done');
      await failsWith(() => e2eExpect.poll(() => 'running', { timeout: 30, intervals: [5] }).toBe('done'), /timed out after 30 ms/);
    });
    vexpect(scope.close()).toBeUndefined();
  });

  it('a poll belongs to the phase that started it, not to the phase running when it is called', async () => {
    const timedOut = new PollScope('the test body');
    const status = counting();
    let resume!: () => void;
    const leftover = runInPollScope(timedOut, async () => {
      await new Promise<void>((resolve) => {
        resume = resolve;
      });
      return e2eExpect.poll(status.read, { timeout: 5000 }).toBe('done');
    });
    timedOut.close();
    const next = new PollScope('the test body');
    await runInPollScope(next, async () => {
      resume();
      const rejection = await rejectionOf(leftover);
      vexpect(rejection).toMatchObject({ code: 'CANCELLED' });
      vexpect(isAbandonedRejection(rejection)).toBe(true);
    });
    vexpect(status.reads()).toBe(0);
    vexpect(next.close()).toBeUndefined();
  });

  it('hands a lineage over to the scope current when it is handed over', async () => {
    const body = new PollScope('the test body');
    const lineage = runInPollScope(body, () => pollLineage());
    vexpect(lineage.run(() => currentPollScope())).toBe(body);
    body.close();
    const teardown = new PollScope('the fixture "workspace" teardown');
    runInPollScope(teardown, () => lineage.handOver());
    const poll = lineage.run(() => e2eExpect.poll(() => 'running', { timeout: 5000 }).toBe('done'));
    vexpect(teardown.close()?.message).toMatch(/^the fixture "workspace" teardown returned before/);
    await rejectionOf(poll);
  });

  it('marks the rejection of a promise derived from an abandoned poll', async () => {
    const scope = new PollScope('the test body');
    const derived = runInPollScope(scope, () =>
      e2eExpect.poll(() => 'running', { timeout: 5000 }).toBe('done').then(() => 'never'),
    );
    scope.close();
    vexpect(isAbandonedRejection(await rejectionOf(derived))).toBe(true);
  });

  it('stays out of the way of a poll outside any scope', async () => {
    vexpect(currentPollScope()).toBeUndefined();
    const poll = e2eExpect.poll(settling('running', 'done', 2).read, { intervals: [5] }).toBe('done');
    const scope = new PollScope('the test body');
    vexpect(scope.close()).toBeUndefined();
    await poll;
  });
});

describe('expect.poll toMatchSchema', () => {
  it('resolves to the schema output of the first read that passes', async () => {
    const { read } = settling<unknown>({ status: 'pending' }, { status: 'done', items: [1] }, 2);
    const done = z.object({ status: z.literal('done'), items: z.array(z.number()), page: z.number().default(1) });
    vexpect(await e2eExpect.poll(read, { intervals: [1] }).toMatchSchema(done)).toEqual({ status: 'done', items: [1], page: 1 });
  });
});

describe('expect(fn).toPass()', () => {
  it('retries failures with other error codes and thrown values', async () => {
    let tries = 0;
    await e2eExpect(() => {
      tries += 1;
      if (tries === 1) throw new TestError('INVALID_ARGUMENT', 'not ready');
      if (tries === 2) throw 'still waiting';
    }).toPass({ timeout: 1000, intervals: [10] });
    vexpect(tries).toBe(3);
  });

  it('reports the custom message and last thrown error at the deadline', async () => {
    let tries = 0;
    const last = new Error('still waiting');
    await vexpect(e2eExpect(() => {
      if (++tries === 1) throw new Error('first try');
      throw last;
    }, 'waiting for the job').toPass({ timeout: 100, intervals: [10] })).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: 'expect(...).toPass() timed out after 100 ms\nwaiting for the job\nlast: still waiting',
      cause: last,
    });
  });

  it('backs off by 100, 250, 500 and 1000 ms, then repeats 1000 ms', async () => {
    const start = Date.now();
    const tries: number[] = [];
    await e2eExpect(async () => {
      await Promise.resolve();
      tries.push(Date.now() - start);
      e2eExpect(tries.length).toBe(6);
    }).toPass({ timeout: 5000 });
    vexpect(tries).toEqual([0, 100, 350, 850, 1850, 2850]);
  });

  it('times out when a synchronous block passes after the deadline', async () => {
    await failsWith(
      () => e2eExpect(() => { vi.advanceTimersByTime(60); }).toPass({ timeout: 10 }),
      /timed out after 10 ms\nlast: no try completed$/,
    );
  });

  it('requires a positive timeout outside a test', async () => {
    await vexpect(e2eExpect(() => {}).toPass()).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: vexpect.stringContaining('expect(...).toPass() timeout 0 waits for the test deadline'),
    });
  });

  it('reports the attempt deadline when there is no timeout on the block', async () => {
    const live = attempt({ assertionTimeout: 20, deadlineMs: 150 });
    try {
      await failsWith(
        () => e2eExpect(() => e2eExpect(false).toBe(true)).toPass(),
        /^expect\(\.\.\.\)\.toPass\(\) stopped at the attempt deadline after 150 ms\n/,
        /last: expected false to be true$/,
      );
    } finally {
      live.end();
    }
  });

  it('waits at the phase deadline for the runner to cancel', async () => {
    const live = attempt({ assertionTimeout: 20, deadlineMs: 150 });
    try {
      setTimeout(live.cancel, 165);
      await vexpect(e2eExpect(() => { throw new Error('not ready'); }).toPass()).rejects.toMatchObject({ code: 'CANCELLED' });
    } finally {
      live.end();
    }
  });

  it('keeps the toPass timeout when the phase deadline moves during a pause', async () => {
    const live = attempt({ assertionTimeout: 5000, deadlineMs: 80 });
    try {
      const started = Date.now();
      setTimeout(() => live.budget.shiftDeadline(1000), 40);
      await failsWith(
        () => e2eExpect(() => e2eExpect(false).toBe(true)).toPass({ timeout: 200, intervals: [500] }),
        /^expect\(\.\.\.\)\.toPass\(\) timed out after 200 ms\n/,
      );
      vexpect(Date.now() - started).toBe(200);
    } finally {
      live.end();
    }
  });

  it('refuses call timeouts longer than a timer can wait', async () => {
    const timeout = 2 ** 31;
    vexpect(() => e2eExpect.poll(() => true, { timeout })).toThrow(
      vexpect.objectContaining({ code: 'INVALID_CONFIG', message: 'expect.poll timeout must be at most 2147483647 milliseconds, got 2147483648' }),
    );
    await vexpect(e2eExpect(() => {}).toPass({ timeout })).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: 'expect(...).toPass() timeout must be at most 2147483647 milliseconds, got 2147483648',
    });
  });

  it('refuses invalid options before calling the block', async () => {
    let tries = 0;
    const assertion = e2eExpect(() => ++tries);
    await vexpect(assertion.toPass({ timeout: -1 })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await vexpect(assertion.toPass({ timeout: 100, intervals: [] })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    vexpect(tries).toBe(0);
  });

  it.each([{ options: null }, { options: [] }, { options: new Date() }])('refuses a non-plain toPass options object: $options', async ({ options }) => {
    const assertion = e2eExpect(() => {});
    await vexpect(Reflect.apply(assertion.toPass, assertion, [options])).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: 'expect(...).toPass() options must be a plain object',
    });
  });

  it('names intervals when toPass receives interval', async () => {
    const assertion = e2eExpect(() => {});
    await vexpect(Reflect.apply(assertion.toPass, assertion, [{ interval: 5, timeout: 3000 }])).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: vexpect.stringMatching(/unknown key "interval".*"intervals"/),
    });
  });

  it('quotes a string in the interval list', async () => {
    const assertion = e2eExpect(() => {});
    await vexpect(Reflect.apply(assertion.toPass, assertion, [{ intervals: [10, '20'] }])).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: 'expect(...).toPass() intervals[1] must be a positive safe integer of milliseconds, got "20"',
    });
  });

  it('refuses a fractional pause in toPass intervals', async () => {
    await vexpect(e2eExpect(() => {}).toPass({ timeout: 10, intervals: [0.5] })).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: 'expect(...).toPass() intervals[0] must be a positive safe integer of milliseconds, got 0.5',
    });
  });

  it('refuses to run a value that is not a function', async () => {
    const assertion = e2eExpect('a value');
    const matcher: unknown = Reflect.get(assertion, 'toPass');
    if (typeof matcher !== 'function') throw new Error('expected the runtime matcher');
    await vexpect(Reflect.apply(matcher, assertion, [{ timeout: 100 }])).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'expect(...).toPass() requires a function',
    });
  });

  it('passes a negated check on the first throw', async () => {
    let tries = 0;
    await e2eExpect(() => {
      if (++tries === 3) throw new Error('stopped');
    }).not.toPass({ timeout: 100, intervals: [10] });
    vexpect(tries).toBe(3);
  });

  it('fails a negated check at the deadline when the block keeps passing', async () => {
    await vexpect(e2eExpect(() => {}).not.toPass({ timeout: 100, intervals: [10] })).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: 'expect(...).not.toPass() timed out after 100 ms\nlast: the block passed',
    });
  });

  it.each(['toPass', 'not.toPass'])('%s keeps a late throw in the timeout error', async (matcher) => {
    const cause = new Error('too late');
    const assertion = e2eExpect(() => {
      vi.advanceTimersByTime(60);
      throw cause;
    });
    const target = matcher === 'toPass' ? assertion : assertion.not;
    await vexpect(target.toPass({ timeout: 10 })).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: `expect(...).${matcher}() timed out after 10 ms\nlast: too late`,
      cause,
    });
  });

  it('stops waiting for a hung try at the deadline', async () => {
    const started = Date.now();
    await failsWith(
      () => e2eExpect(() => new Promise(() => {})).toPass({ timeout: 100 }),
      /timed out after 100 ms\nlast: no try completed$/,
    );
    vexpect(Date.now() - started).toBe(100);
  });

  it('stops a nested poll at the block deadline outside a test', async () => {
    const status = settling(false, true, 100);
    await failsWith(
      () => e2eExpect(async () => {
        await e2eExpect.poll(status.read, { timeout: 600, intervals: [50] }).toBe(true);
      }).toPass({ timeout: 120 }),
      /timed out after 120 ms/,
    );

    const readsAtCutoff = status.reads();
    vexpect(readsAtCutoff).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 600));
    vexpect(status.reads()).toBe(readsAtCutoff);
  });

  it('cancels a negated check when the attempt aborts during a try', async () => {
    const live = attempt({ assertionTimeout: 5000, deadlineMs: 10_000 });
    try {
      const result = e2eExpect(() => new Promise(() => {})).not.toPass();
      setTimeout(live.cancel, 20);
      await vexpect(result).rejects.toMatchObject({ code: 'CANCELLED' });
    } finally {
      live.end();
    }
  });
});
