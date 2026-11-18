/** Notte's cloud browsers as a `BrowserProvider` for the web engine. */

import { setTimeout as sleep } from 'node:timers/promises';
import { releaseEach, type BrowserDownloadContext, type BrowserLease, type BrowserProvider, type BrowserReleaseContext, type BrowserRequest } from '@e2e-dev/web';
import { envValue } from './env.ts';
import { forget, prune, remember, remembered } from './ledger.ts';
import { notteSessions, type NotteSessionParams, type NotteSessions } from './client.ts';

const NOTTE_API_KEY = 'NOTTE_API_KEY';
const NOTTE_API_URL = 'NOTTE_API_URL';

/**
 * Where the engine asks the browser to save downloads. Notte saves every
 * download of a session under `/tmp/session-downloads/<session id>` whatever
 * path a client names, and collects it into the session's file storage.
 */
const DOWNLOADS_DIR = '/tmp/session-downloads';

/** How often `downloads.read` asks Notte again for a download it has not collected yet. */
const DOWNLOAD_POLL_MS = 500;

/** An error's message, or the thrown value as text. */
const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** The Notte console page of one session, which needs a console sign-in rather than a token. */
const consoleUrl = (sessionId: string): string => `https://console.notte.cc/sessions/${sessionId}`;

/**
 * Notte's start-session body as it is: `solve_captchas`, `proxies`,
 * `browser_type`, `idle_timeout_minutes`, `max_duration_minutes`,
 * `viewport_width`, `viewport_height`, `profile`, `user_agent`, ...
 */
export type NotteOptions = NotteSessionParams;

/**
 * Notte cloud browsers for `web({ browser: notte() })`: a fresh session per
 * test attempt, started when the attempt starts and stopped when it ends.
 * The scope is always `attempt`: a Notte session owns its one browser
 * context and refuses `Target.createBrowserContext`, which a shared
 * per-worker browser needs to keep tests apart. When the run ends, `sweep`
 * stops the sessions of workers that died before they could, and Notte ends
 * any session the run itself left after `idle_timeout_minutes`.
 * `NOTTE_API_KEY` comes from the run's environment, and `NOTTE_API_URL`
 * when set.
 */
export function notte(options: NotteOptions = {}): BrowserProvider {
  const params = { ...options };
  /** The storage file ids each session's downloads were already read from, so each finished download is read once. */
  const claimed = new Map<string, Set<string>>();
  /**
   * The bytes of one download of the lease's session, read once. Notte stores
   * a download under the name the site suggested, not the download id the
   * engine knows, so the file is found by `context.suggestedFilename`: the
   * oldest unread file of that name.
   */
  const readDownload = async (lease: BrowserLease, file: string, context: BrowserDownloadContext): Promise<Uint8Array> => {
    const client = clientFor(context.env);
    let seen = claimed.get(lease.id);
    if (seen === undefined) {
      seen = new Set();
      claimed.set(lease.id, seen);
    }
    for (;;) {
      const next = (await client.downloads(lease.id, context.signal)).find((download) => !seen.has(download.id) && download.filename === context.suggestedFilename);
      if (next !== undefined) {
        seen.add(next.id);
        return client.readFile(lease.id, next.id, context.signal);
      }
      await sleep(DOWNLOAD_POLL_MS, undefined, { signal: context.signal }).catch(() => {
        throw new Error(`download ${file} never reached session ${lease.id}'s file storage`);
      });
    }
  };
  const clients = new Map<string, NotteSessions>();
  const clientFor = (env: BrowserRequest['env']): NotteSessions => {
    const apiKey = envValue(env, NOTTE_API_KEY);
    if (apiKey === undefined) throw new Error(`${NOTTE_API_KEY} is not set`);
    const baseUrl = envValue(env, NOTTE_API_URL);
    const key = `${baseUrl ?? ''}\n${apiKey}`;
    let client = clients.get(key);
    if (client === undefined) {
      client = notteSessions(apiKey, baseUrl);
      clients.set(key, client);
    }
    return client;
  };
  return {
    name: 'notte',
    scope: 'attempt',
    async acquire(request: BrowserRequest): Promise<BrowserLease> {
      const client = clientFor(request.env);
      request.signal.throwIfAborted();
      const session = await client.start(params);
      // Recorded before anything can fail, so a worker that dies from here on leaves the session to the sweep.
      const unrecorded = await remember(request.runId, request.targetName, session.sessionId).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      const { cdpUrl } = session;
      if (unrecorded !== undefined || cdpUrl === undefined || request.signal.aborted) {
        const why =
          unrecorded !== undefined
            ? `could not be recorded for the run's sweep (${messageOf(unrecorded)})`
            : cdpUrl === undefined
              ? 'started without a CDP URL'
              : 'arrived after the request was cancelled';
        const fallback = unrecorded === undefined ? "the run's sweep or Notte's idle_timeout_minutes ends it" : "Notte's idle_timeout_minutes ends it";
        const outcome = await client.stop(session.sessionId, AbortSignal.timeout(10_000)).then(
          async () => {
            if (unrecorded === undefined) await forget(request.runId, request.targetName, session.sessionId);
            return 'stopped';
          },
          (cause: unknown) => `stopping it failed, so ${fallback}: ${messageOf(cause)}`,
        );
        throw new Error(`session ${session.sessionId} ${why}; ${outcome}`);
      }
      // Never the viewer URL: it carries tokens that act on the session, and a run's log is often public CI output.
      request.log(envValue(request.env, NOTTE_API_URL) === undefined ? `session ${session.sessionId}, watch at ${consoleUrl(session.sessionId)}` : `session ${session.sessionId}`);
      return { id: session.sessionId, cdpEndpoint: cdpUrl };
    },
    async release(lease: BrowserLease, context: BrowserReleaseContext): Promise<void> {
      claimed.delete(lease.id);
      await clientFor(context.env).stop(lease.id, context.signal);
      await forget(context.runId, context.targetName, lease.id);
    },
    async sweep(context: BrowserReleaseContext): Promise<readonly string[]> {
      const open = await remembered(context.runId, context.targetName);
      if (open.length === 0) {
        await prune(context.runId, context.targetName);
        return [];
      }
      const client = clientFor(context.env);
      const { released, failed } = await releaseEach(open, (id) => client.stop(id, context.signal));
      const unstopped = new Set(failed.map(({ id }) => id));
      // A marker goes only once Notte confirmed the stop; the marker of a failed stop stays.
      await Promise.all(open.filter((id) => !unstopped.has(id)).map((id) => forget(context.runId, context.targetName, id)));
      await prune(context.runId, context.targetName);
      if (failed.length > 0) {
        const notStopped = failed.map(({ id, reason }) => `${id} (${reason})`).join(', ');
        throw new Error(`stopped ${released.length === 0 ? 'none' : released.join(', ')}; could not stop ${notStopped}, so Notte ends it after idle_timeout_minutes`);
      }
      return released;
    },
    downloads: { dir: DOWNLOADS_DIR, read: readDownload },
  };
}
