/** The slice of the Notte SDK the provider uses, loaded on first use so a config load never pays for it. */

import type { ApiSessionStartRequest } from 'notte-sdk';

/**
 * Notte's start-session body, less the fields a browser provider cannot
 * serve: `cdp_url` (a browser from another provider) and managed
 * authentication (`auth_ids`, `auth_retry`, `wait_for_authentication`),
 * which returns the session before it can be attached to.
 */
export type NotteSessionParams = Omit<ApiSessionStartRequest, 'cdp_url' | 'auth_ids' | 'auth_retry' | 'wait_for_authentication'>;

interface NotteSession {
  readonly sessionId: string;
  /** Undefined when Notte gave the session no CDP URL, in the start response or its debug info. */
  readonly cdpUrl: string | undefined;
}

/** A file the session's browser downloaded, as Notte's file storage lists it. */
export interface NotteDownload {
  readonly id: string;
  readonly filename: string;
  readonly createdAt: string;
}

export interface NotteSessions {
  /**
   * Starts a session. The request is never aborted: a cancelled request would
   * leave a session Notte started that nobody knows the id of, so the caller
   * waits for it and stops it instead. A start response without a CDP URL
   * falls back to the session's debug info, as the SDK's own `Session` does.
   */
  start(params: NotteSessionParams): Promise<NotteSession>;
  /** Stops the session; one Notte already closed counts as stopped. Resolves to whether Notte still had it open. */
  stop(sessionId: string, signal: AbortSignal): Promise<boolean>;
  /**
   * Every file the session's browser downloaded, oldest first, read page by
   * page. Files that share a time come out in reverse of Notte's listing
   * order, which is newest first. Notte collects a finished download into
   * the session's file storage when this lists it, after the session's
   * downloads settle.
   */
  downloads(sessionId: string, signal: AbortSignal): Promise<NotteDownload[]>;
  /** The bytes of one file in the session's storage. */
  readFile(sessionId: string, fileId: string, signal: AbortSignal): Promise<Uint8Array>;
}

/** Whether a failed stop says the session had already ended, the way the SDK's own `Session.stop` reads it. */
function alreadyClosed(cause: unknown, statusCode: number | undefined): boolean {
  if (statusCode === 404) return true;
  const text = (cause instanceof Error ? cause.message : String(cause)).toLowerCase();
  return text.includes('already stopped') || text.includes('already closed');
}

/** How many files one `files.list` request asks for: Notte's own page size. */
const FILES_PAGE = 100;

/** Notte sessions for one API key and API URL, through the SDK. */
export function notteSessions(apiKey: string, baseUrl: string | undefined): NotteSessions {
  const sdk = import('notte-sdk').then((module) => ({
    client: new module.NotteClient({ apiKey, ...(baseUrl === undefined ? {} : { baseUrl }) }),
    NotteAPIError: module.NotteAPIError,
  }));
  return {
    async start(params) {
      const { client } = await sdk;
      const session = await client.sessions.start(params);
      if (typeof session.cdp_url === 'string' && session.cdp_url !== '') return { sessionId: session.session_id, cdpUrl: session.cdp_url };
      const debug = await client.sessions.debugInfo(session.session_id, { signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
      const cdpUrl = debug?.ws.cdp;
      return { sessionId: session.session_id, cdpUrl: typeof cdpUrl === 'string' && cdpUrl !== '' ? cdpUrl : undefined };
    },
    async stop(sessionId, signal) {
      const { client, NotteAPIError } = await sdk;
      try {
        const session = await client.sessions.stop(sessionId, undefined, { signal });
        if (session.status !== 'closed') throw new Error(`session ${sessionId} is still ${session.status} after stop`);
        return true;
      } catch (cause) {
        if (alreadyClosed(cause, cause instanceof NotteAPIError ? cause.statusCode : undefined)) return false;
        throw cause;
      }
    },
    async downloads(sessionId, signal) {
      const { client } = await sdk;
      const listed = new Map<string, NotteDownload>();
      for (let offset = 0; ; ) {
        const page = await client.files.list(sessionId, { source: 'session_download', limit: FILES_PAGE, offset }, { signal });
        // A file stored between two pages shifts the newest-first listing down: the next page repeats one, never skips one.
        for (const file of page.files) if (!listed.has(file.id)) listed.set(file.id, { id: file.id, filename: file.filename, createdAt: file.created_at });
        offset += page.files.length;
        if (page.files.length === 0 || offset >= page.total) break;
      }
      // Reversed, then a stable sort by time: files that share a time come out in reverse of Notte's listing order.
      return [...listed.values()].toReversed().toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    },
    async readFile(sessionId, fileId, signal) {
      const { client } = await sdk;
      // The generated client types the body `unknown`; the typed `Files(id).download` takes no abort signal.
      const body = await client.files.download(sessionId, fileId, { signal });
      if (!(body instanceof Blob)) throw new Error(`Notte answered file ${fileId} of session ${sessionId} with no file body`);
      return new Uint8Array(await body.arrayBuffer());
    },
  };
}
