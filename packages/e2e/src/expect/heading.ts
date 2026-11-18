/** The caller's label for a check, as it opens a failure message. */

import { isE2EError, TestError } from '@e2e-dev/core/lib/internal/errors';

/** `text` after the caller's `message` and a colon, or `text` alone when there is no message. */
export function withMessage(message: string | undefined, text: string): string {
  return message === undefined ? text : `${message}: ${text}`;
}

/**
 * An ambiguous locator's error opened with the caller's message, as an
 * assertion failure is: it is the commonest way a check fails at once. The
 * code and details stay; the original is the cause, so the report keeps its
 * stack. Any other error is returned as it is.
 */
export function labelAmbiguous(error: unknown, message: string | undefined): unknown {
  if (message === undefined || !isE2EError(error) || error.code !== 'LOCATOR_AMBIGUOUS') return error;
  return new TestError('LOCATOR_AMBIGUOUS', withMessage(message, error.message), {
    ...(error.details === undefined ? {} : { details: error.details }),
    cause: error,
  });
}
