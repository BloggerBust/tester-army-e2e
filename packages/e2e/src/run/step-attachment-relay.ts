import { randomInt } from 'node:crypto';
import { classifyError, ConfigurationError, E2EError, errorMessage } from '@e2e-dev/core/lib/internal/errors';
import { uuidv7 } from '@e2e-dev/core/lib/internal/ids';
import { abortError, cancelledError } from '@e2e-dev/core/lib/internal/time';
import { errorResult } from '../session-tools/tools.ts';
import type { HeldTestAttachment } from './step-attachment-wire.ts';
import type { UnitRunner } from './unit-runner.ts';
import type { StepAttachmentRequest, StepAttachmentResponse, StepHoldMessage, WorkerToMain } from './worker/protocol.ts';

const ID_CHARACTERS = 'abcdefghjkmnpqrstuvwxyz23456789';

type HeldAttemptState = {
  readonly attemptId: string;
  readonly attachId: string;
  labels: StepHoldMessage['attachmentLabels'];
  attachment: ((reason: string, releasing?: boolean) => Promise<string | undefined>) | undefined;
};

type PendingAttachmentReply = {
  readonly worker: UnitRunner;
  readonly resolve: (response: StepAttachmentResponse) => void;
  readonly reject: (reason: Error) => void;
};

type AttachmentReply<Kind extends StepAttachmentRequest['kind']> = Extract<StepAttachmentResponse, { kind: Kind }>;

/** Narrows a worker reply to the kind of its matching request. */
function isAttachmentReply<Kind extends StepAttachmentRequest['kind']>(
  response: StepAttachmentResponse,
  kind: Kind,
): response is AttachmentReply<Kind> {
  return response.kind === kind;
}

/** Relays attachments and their tool calls to the worker holding each test. */
export class StepAttachmentRelay {
  private readonly attempts = new Map<UnitRunner, HeldAttemptState>();
  private readonly holds = new Map<string, { readonly worker: UnitRunner; readonly attempt: HeldAttemptState }>();
  private readonly replies = new Map<string, PendingAttachmentReply>();

  constructor(private readonly interrupting: () => boolean) {}

  /** Reserves a pause ID until this attempt ends and exposes the current hold for attachment. */
  hold(worker: UnitRunner, holdId: string, attemptId: string, labels: StepHoldMessage['attachmentLabels']): string {
    let attempt = this.attempts.get(worker);

    if (attempt?.attemptId !== attemptId) {
      attempt = {
        attemptId,
        attachId: this.newId(),
        labels,
        attachment: undefined,
      };
      this.attempts.set(worker, attempt);
    } else {
      attempt.labels = labels;
    }

    this.holds.set(holdId, { worker, attempt });
    return attempt.attachId;
  }

  /** Drops a hold and ends any attachment to it. */
  release(holdId: string, reason: string): void {
    const hold = this.holds.get(holdId);

    if (hold !== undefined) {
      this.holds.delete(holdId);
      void hold.attempt.attachment?.(reason, true).catch(() => undefined);
    }
  }

  /** Releases the ID reserved for the worker's finished attempt. */
  endAttempt(worker: UnitRunner): void {
    this.attempts.delete(worker);
  }

  /** Finishes every request still waiting for a worker that exited. */
  workerExited(worker: UnitRunner, reason: string): void {
    this.endAttempt(worker);

    for (const waiting of this.replies.values()) {
      if (waiting.worker === worker) {
        waiting.reject(new ConfigurationError('NO_SESSION', reason));
      }
    }
  }

  /** Completes a request only when the worker it was sent to answers. */
  reply(worker: UnitRunner, message: Extract<WorkerToMain, { type: 'step-attachment-reply' }>): void {
    const pending = this.replies.get(message.requestId);

    if (pending?.worker === worker) {
      pending.resolve(message.response);
    }
  }

  /** Picks an ID that no active attempt uses. */
  private newId(): string {
    const used = new Set([...this.attempts.values()].map((attempt) => attempt.attachId));
    let id: string;

    do {
      id = Array.from({ length: 4 }, () => ID_CHARACTERS.charAt(randomInt(ID_CHARACTERS.length))).join('');
    } while (used.has(id));

    return id;
  }

  /** Opens an attachment to the worker running the test named by the pause ID. */
  readonly attach = async (attachId: string, openingSignal?: AbortSignal, sessionId?: string): Promise<HeldTestAttachment> => {
    const held = [...this.holds].find(([, { attempt }]) => attempt.attachId === attachId);

    if (held === undefined || this.interrupting()) {
      const heldTests = new Set(
        [...this.holds.values()].map(({ attempt }) =>
          `${attempt.attachId}  ${attempt.labels.title} [${attempt.labels.target}]`,
        ),
      );
      const list = heldTests.size === 0 ? ['No tests are held.'] : ['Held tests:', ...heldTests];

      throw new ConfigurationError('NO_SESSION', ['no held test matches that attachment id', ...list].join('\n'));
    }

    const [holdId, { worker, attempt }] = held;

    if (attempt.attachment !== undefined) {
      throw new ConfigurationError('INVALID_ARGUMENT', 'this test already has an attachment');
    }

    const controller = new AbortController();
    const { signal } = controller;
    const ended = new AbortController();
    const attachmentId = uuidv7();
    let closing: Promise<string | undefined> | undefined;

    /** Cancels calls and asks the worker to save the recording. */
    const end = (reason: string, releasing = false): Promise<string | undefined> => {
      if (closing === undefined) {
        controller.abort(new ConfigurationError('NO_SESSION', reason));
        closing = this.requestAttachment(worker, uuidv7(), { kind: 'detach', attachmentId }).then(
          ({ recording }) => {
            ended.abort(new ConfigurationError('NO_SESSION', reason));
            return recording;
          },
          (cause: unknown) => {
            ended.abort(new ConfigurationError('NO_SESSION', `${reason}\n${errorMessage(cause)}`));
            throw cause;
          },
        ).finally(() => {
          if (attempt.attachment === end) {
            attempt.attachment = undefined;
          }
        });
      }

      if (releasing) {
        ended.abort(new ConfigurationError('NO_SESSION', reason));
      }

      return closing;
    };
    attempt.attachment = end;

    try {
      const opening = await this.requestAttachment(
        worker,
        attachmentId,
        {
          kind: 'attach',
          holdId,
          attachId,
          sessionId: sessionId ?? attachmentId,
        },
        openingSignal === undefined ? signal : AbortSignal.any([signal, openingSignal]),
      );

      if (signal.aborted) {
        throw abortError(signal, cancelledError);
      }

      if (openingSignal?.aborted === true) {
        throw abortError(openingSignal, cancelledError);
      }

      return {
        opening: opening.opening,
        signal: ended.signal,
        detail: async (name) => {
          const detail = await this.requestAttachment(worker, uuidv7(), { kind: 'detail', attachmentId, name }, signal);

          return detail.text;
        },
        call: async (name, args, cancel) => {
          try {
            const call = await this.requestAttachment(
              worker,
              uuidv7(),
              { kind: 'call', attachmentId, name, args },
              cancel === undefined ? signal : AbortSignal.any([signal, cancel]),
            );

            return call.errorCode === undefined ? call.result : {
              ...call.result,
              errorCode: call.errorCode,
            };
          } catch (cause) {
            return {
              ...errorResult(cause),
              errorCode: classifyError(cause).code,
            };
          }
        },
        detach: () => end('the attachment was detached'),
      };
    } catch (cause) {
      if (openingSignal?.aborted === true && !signal.aborted) {
        await end('the attachment was detached');
      } else if (closing === undefined && attempt.attachment === end) {
        attempt.attachment = undefined;
      }

      throw cause;
    }
  };

  /** Sends a request to the worker and waits for its reply or cancellation. */
  private async requestAttachment<Kind extends StepAttachmentRequest['kind']>(
    worker: UnitRunner,
    requestId: string,
    request: StepAttachmentRequest & { readonly kind: Kind },
    signal?: AbortSignal,
  ): Promise<AttachmentReply<Kind>> {
    if (signal?.aborted === true) {
      throw abortError(signal, cancelledError);
    }

    if (!worker.alive) {
      throw new ConfigurationError('NO_SESSION', 'the worker exited');
    }

    const response = await new Promise<StepAttachmentResponse>((resolve, reject) => {
      /** Removes the waiter when the request settles. */
      const finish = (): void => {
        this.replies.delete(requestId);
        signal?.removeEventListener('abort', cancel);
      };

      /** Rejects the waiter and asks the worker to cancel the request. */
      const cancel = (): void => {
        finish();
        reject(signal === undefined ? cancelledError() : abortError(signal, cancelledError));
        worker.send({ type: 'step-attachment-cancel', requestId });
      };

      this.replies.set(requestId, {
        worker,
        resolve: (reply) => {
          finish();
          resolve(reply);
        },
        reject: (reason) => {
          finish();
          reject(reason);
        },
      });
      signal?.addEventListener('abort', cancel, { once: true });
      worker.send({ type: 'step-attachment-request', requestId, request });
    });

    if (response.kind === 'error') {
      const { category, code, message } = response.error;
      throw new E2EError(category, code, message);
    }

    if (!isAttachmentReply(response, request.kind)) {
      throw new Error('attachment reply does not match its request');
    }

    return response;
  }
}
