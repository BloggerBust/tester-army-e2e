import net from 'node:net';
import { ConfigurationError, E2EError } from '@e2e-dev/core/lib/internal/errors';
import { uuidv7 } from '@e2e-dev/core/lib/internal/ids';
import { abortError, cancelledError } from '@e2e-dev/core/lib/internal/time';
import {
  ATTACH_PROTOCOL,
  AttachReply,
  type AttachRequest,
  type HeldTestAttachment,
  type HeldTestOpening,
  NO_HELD_TEST,
} from '../run/step-attachment-wire.ts';
import { parseLine, readSocketLines, stepAddress } from '../run/step-socket.ts';

type RequestReply = Extract<AttachReply, { type: 'detail' | 'result' }>;

type PendingReply<Value> = {
  resolve(value: Value): void;
  reject(reason: Error): void;
};

/** Connects to a held test in the MCP server's directory. */
export async function connectHeldTest(
  cwd: string,
  version: string,
  id: string,
  sessionId: string,
  signal: AbortSignal,
  onRecording: (text: string) => void,
): Promise<HeldTestAttachment> {
  if (signal.aborted) {
    throw abortError(signal, cancelledError);
  }

  const client = new AttachmentClient(stepAddress(cwd).socket, version, { type: 'attach', id, sessionId }, onRecording);

  /** Closes the connection if the client cancels the open request. */
  const cancel = (): void => client.end(abortError(signal, cancelledError));

  signal.addEventListener('abort', cancel, { once: true });

  try {
    const opening = await client.opened;

    if (client.signal.aborted) {
      throw abortError(client.signal, cancelledError);
    }

    return {
      opening,
      signal: client.signal,
      detail: (name) => client.detail(name),
      call: (name, args, requestSignal) => client.call(name, args, requestSignal),
      detach: () => client.detach(),
    };
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

/** An attachment socket and the requests waiting for replies on it. */
class AttachmentClient {
  private readonly socket: net.Socket;
  private readonly attachmentEnd = new AbortController();
  private opening: PendingReply<HeldTestOpening> | undefined;
  private readonly pending = new Map<string, PendingReply<RequestReply>>();
  private phase: 'hello' | 'opening' | 'open' = 'hello';
  private detachPromise: Promise<string | undefined> | undefined;
  private detachReply: ((recording?: string) => void) | undefined;

  readonly opened = new Promise<HeldTestOpening>((resolve, reject) => {
    this.opening = { resolve, reject };
  });
  readonly signal = this.attachmentEnd.signal;

  constructor(
    socket: string,
    version: string,
    private readonly attach: Extract<AttachRequest, { type: 'attach' }>,
    private readonly onRecording: (text: string) => void,
  ) {
    this.socket = net.connect(socket, () => {
      this.socket.write(`${JSON.stringify({ type: 'hello', protocol: ATTACH_PROTOCOL, version })}\n`);
    });

    this.socket.on('error', (cause) => {
      this.end('code' in cause && (cause.code === 'ENOENT' || cause.code === 'ECONNREFUSED')
        ? new ConfigurationError('NO_SESSION', NO_HELD_TEST)
        : cause);
    });
    this.socket.once('close', () => this.end(new ConfigurationError('NO_SESSION', 'the step socket closed')));
    readSocketLines(this.socket, (line) => {
      this.receive(parseLine(line, AttachReply));
      return !this.socket.destroyed;
    });
  }

  /** Ends the session, leaving the socket open only to receive a recording result. */
  end(reason: Error, keepSocket = false): void {
    if (keepSocket) {
      this.socket.unref();
    } else {
      this.socket.destroy();
    }

    if (this.signal.aborted) {
      return;
    }

    this.attachmentEnd.abort(reason);
    this.opening?.reject(reason);
    this.opening = undefined;
    this.detachReply?.();
    this.detachReply = undefined;

    for (const request of this.pending.values()) {
      request.reject(reason);
    }
  }

  /** Reads the detailed contract of one tool. */
  async detail(name: string): Promise<string> {
    const reply = await this.request({ type: 'detail', requestId: uuidv7(), name });

    if (reply.type !== 'detail') {
      throw new Error('expected a tool detail reply from the step socket');
    }

    return reply.text;
  }

  /** Drives the held test via the runner and returns the worker's MCP result. */
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): ReturnType<HeldTestAttachment['call']> {
    const reply = await this.request({ type: 'call', requestId: uuidv7(), name, args }, signal);

    if (reply.type !== 'result') {
      throw new Error('expected a tool call result from the step socket');
    }

    const { content, isError } = reply.result;
    return {
      content,
      ...(isError === undefined ? {} : { isError }),
      ...(reply.errorCode === undefined ? {} : { errorCode: reply.errorCode }),
    };
  }

  /** Waits for detach to finish so an immediate reattach can claim the attempt. */
  detach(): Promise<string | undefined> {
    if (this.detachPromise === undefined) {
      if (this.signal.aborted) {
        return Promise.resolve(undefined);
      }

      this.detachPromise = new Promise<string | undefined>((resolve) => {
        this.detachReply = resolve;
        this.socket.write(`${JSON.stringify({ type: 'detach' } satisfies AttachRequest)}\n`);
      });
    }

    return this.detachPromise;
  }

  /** Dispatches a frame in handshake order, then by its request id. */
  private receive(reply: AttachReply | undefined): void {
    if (this.signal.aborted) {
      if (reply?.type === 'recording') {
        if (reply.text !== undefined) {
          this.onRecording(reply.text);
        }

        this.socket.destroy();
      }

      return;
    }

    if (reply?.type === 'error') {
      const error = new E2EError(reply.category, reply.code, reply.message);

      if (reply.requestId === undefined) {
        this.end(error);
      } else {
        this.pending.get(reply.requestId)?.reject(error);
      }

      return;
    }

    if (this.phase === 'hello' && reply?.type === 'hello') {
      this.phase = 'opening';
      this.socket.write(`${JSON.stringify(this.attach)}\n`);
      return;
    }

    if (reply?.type === 'ended') {
      this.detachReply?.(reply.reason);
      this.detachReply = undefined;
      this.end(new ConfigurationError('NO_SESSION', reply.reason), true);
    } else if (this.phase === 'opening' && reply?.type === 'opening') {
      this.phase = 'open';
      this.opening?.resolve(reply.opening);
      this.opening = undefined;
    } else if (this.phase === 'open' && (reply?.type === 'detail' || reply?.type === 'result')) {
      this.pending.get(reply.requestId)?.resolve(reply);
    } else if (this.detachReply !== undefined && reply?.type === 'detached') {
      this.detachReply(reply.recording);
      this.detachReply = undefined;
      this.end(new ConfigurationError('NO_SESSION', 'the attachment was detached'));
    } else {
      this.end(new ConfigurationError('NO_SESSION', 'invalid attachment reply from the step socket'));
    }
  }

  /** Sends a request and, if cancelled, leaves the attachment open for later calls. */
  private async request(request: Extract<AttachRequest, { type: 'call' | 'detail' }>, signal?: AbortSignal): Promise<RequestReply> {
    if (this.signal.aborted) {
      throw abortError(this.signal, cancelledError);
    }

    if (signal?.aborted === true) {
      throw abortError(signal, cancelledError);
    }

    const { requestId } = request;

    /** Rejects the pending call and cancels it in the run. */
    const cancel = (): void => {
      this.pending.get(requestId)?.reject(cancelledError());
      if (!this.signal.aborted) {
        this.socket.write(`${JSON.stringify({ type: 'cancel', requestId } satisfies AttachRequest)}\n`);
      }
    };

    try {
      return await new Promise<RequestReply>((resolve, reject) => {
        this.pending.set(requestId, { resolve, reject });
        signal?.addEventListener('abort', cancel, { once: true });
        this.socket.write(`${JSON.stringify(request)}\n`);
      });
    } finally {
      signal?.removeEventListener('abort', cancel);
      this.pending.delete(requestId);
    }
  }
}
