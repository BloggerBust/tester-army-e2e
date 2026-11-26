/** Line-delimited JSON sent on a dedicated attachment connection to the step socket. */

import { z } from 'zod';

export const ATTACH_PROTOCOL = 3;

export const AttachHello = z.object({
  type: z.literal('hello'),
  protocol: z.number().int(),
  version: z.string().min(1),
});

const requestId = z.string().min(1);

export const AttachRequest = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('attach'),
    id: z.string().min(1),
    sessionId: z.uuidv7(),
  }),
  z.object({ type: z.literal('detail'), requestId, name: z.string() }),
  z.object({
    type: z.literal('call'),
    requestId,
    name: z.string(),
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({ type: z.literal('cancel'), requestId }),
  z.object({ type: z.literal('detach') }),
]);

/** Requests on an attachment socket after the handshake. */
export type AttachRequest = z.infer<typeof AttachRequest>;

export const AttachReply = z.discriminatedUnion('type', [
  AttachHello,
  z.object({
    type: z.literal('opening'),
    opening: z.object({
      target: z.string(),
      platform: z.string(),
      engine: z.object({ name: z.string(), version: z.string() }).optional(),
      headed: z.boolean(),
      projectTools: z.array(z.string()).readonly(),
      summary: z.string(),
      catalog: z.array(z.string()).readonly(),
      observation: z.string(),
    }),
  }),
  z.object({ type: z.literal('detail'), requestId, text: z.string() }),
  z.object({
    type: z.literal('result'),
    requestId,
    errorCode: z.string().optional(),
    result: z.object({
      content: z.array(z.discriminatedUnion('type', [
        z.object({ type: z.literal('text'), text: z.string() }),
        z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }),
      ])),
      isError: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('error'),
    requestId: requestId.optional(),
    category: z.enum(['configuration', 'infrastructure', 'test', 'internal', 'interrupted']),
    code: z.string(),
    message: z.string(),
  }),
  z.object({
    type: z.literal('detached'),
    recording: z.string().optional(),
  }),
  z.object({ type: z.literal('ended'), reason: z.string() }),
  z.object({ type: z.literal('recording'), text: z.string().optional() }),
]);

/** Replies and end notices on an attachment socket. */
export type AttachReply = z.infer<typeof AttachReply>;

type AttachmentResult = Omit<Extract<AttachReply, { type: 'result' }>['result'], 'isError'> & {
  readonly isError?: boolean;
  /** The runner code of a failed call, when the worker reported one. */
  readonly errorCode?: string;
};

/** The summary, catalog, and the line naming the first screen for a new attachment. */
export type HeldTestOpening = Extract<AttachReply, { type: 'opening' }>['opening'];

/** One connection to a held attempt. */
export type HeldTestAttachment = {
  readonly opening: HeldTestOpening;

  /** The attachment lifetime. The abort reason explains why it ended. */
  readonly signal: AbortSignal;

  /** Describes one tool, including its argument schema. */
  detail(name: string): Promise<string>;

  /** Calls one tool and returns a redacted MCP result. */
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AttachmentResult>;

  /** Ends the attachment and reports where its recording was saved. */
  detach(): Promise<string | undefined>;
};

export const NO_HELD_TEST = 'No test in this directory is held. Add screen.pause() to a test and run it, or start e2e run <files> --step.';
