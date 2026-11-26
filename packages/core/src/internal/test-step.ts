/** Naming a group of calls from inside the running test: `test.step(title, body)`. */

import { currentAttempt } from '../expect/attempt.ts';
import { leftRunning, outlivesTest } from '../expect/poll-scope.ts';
import { markAbandonedRejection } from './abandoned.ts';
import { CollectionError, TestError } from './errors.ts';
import { runningSuiteHook } from './test-timeout.ts';

/**
 * Runs `body` as one named step of the running test and returns what it
 * returns. Where no report takes steps (a `beforeAll` or `afterAll` hook, a
 * worker fixture, a hosted session), `body` just runs. Outside a test the
 * call is a collection error, and from work a test left running it is
 * cancelled.
 */
export async function runTestStep<T>(title: string, body: () => T | Promise<T>): Promise<T> {
  if (typeof title !== 'string' || title.trim() === '') {
    throw new TestError('INVALID_ARGUMENT', `test.step() title must be a non-empty string, got ${typeof title === 'string' ? 'a blank one' : typeof title}`);
  }
  if (typeof body !== 'function') {
    throw new TestError('INVALID_ARGUMENT', `test.step() takes a function after the title, got ${typeof body}`);
  }
  // Work a test left running (a body past its timeout) is no step of the test that runs now.
  if (leftRunning()) {
    const error = new TestError('CANCELLED', 'test.step() was called after its test ended');
    markAbandonedRejection(error);
    throw error;
  }
  // A suite hook or a worker fixture runs outside any attempt, or on one whose steps no report keeps.
  if (runningSuiteHook() !== undefined || outlivesTest()) return body();
  const attempt = currentAttempt();
  if (attempt === undefined) {
    throw new CollectionError('test.step(title, body) must be called inside a test body, a hook, or a fixture');
  }
  return attempt.step === undefined ? body() : attempt.step(title, body);
}
