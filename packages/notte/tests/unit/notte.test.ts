/**
 * `notte()` against a mocked `notte-sdk`: the start body, the progress
 * line, stop on release and after a cancelled request, a session Notte
 * already closed, one SDK client per API key and API URL, downloads read
 * back from the session's file storage, and the sweep of sessions a dead
 * worker left.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserDownloadContext, BrowserReleaseContext, BrowserRequest } from '@e2e-dev/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notte } from '../../src/index.ts';

const sdk = vi.hoisted(() => {
  class NotteAPIError extends Error {
    constructor(readonly statusCode: number, message: string) {
      super(message);
    }
  }
  const state = {
    clients: [] as unknown[],
    started: [] as { body: unknown; signal: AbortSignal | undefined }[],
    stopped: [] as { id: string; signal: AbortSignal | undefined }[],
    counter: 0,
    start: async (_body: unknown): Promise<unknown> => {
      state.counter += 1;
      return { session_id: `s${state.counter}`, status: 'active', cdp_url: `wss://notte/s${state.counter}`, viewer_url: `https://view/s${state.counter}` };
    },
    stop: async (id: string): Promise<unknown> => ({ session_id: id, status: 'closed' }),
    files: new Map<string, { id: string; filename: string; created_at: string; bytes: string }[]>(),
    listed: [] as { sessionId: string; query: unknown }[],
    downloadSignals: [] as (AbortSignal | undefined)[],
    downloadBody: undefined as unknown,
    debugInfo: async (_id: string): Promise<unknown> => ({ ws: { cdp: '' } }),
  };
  class NotteClient {
    constructor(config: unknown) {
      state.clients.push(config);
    }
    files = {
      list: async (sessionId: string, query: { limit?: number; offset?: number }) => {
        state.listed.push({ sessionId, query });
        const all = (state.files.get(sessionId) ?? []).map(({ bytes: _bytes, ...file }) => file);
        const offset = query.offset ?? 0;
        const limit = query.limit ?? 100;
        return { files: all.slice(offset, offset + limit), total: all.length, limit, offset };
      },
      download: async (sessionId: string, fileId: string, options?: { signal?: AbortSignal }) => {
        state.downloadSignals.push(options?.signal);
        return state.downloadBody ?? new Blob([state.files.get(sessionId)?.find((file) => file.id === fileId)?.bytes ?? '']);
      },
    };
    sessions = {
      debugInfo: async (id: string) => state.debugInfo(id),
      start: async (body: unknown, options?: { signal?: AbortSignal }) => {
        state.started.push({ body, signal: options?.signal });
        return state.start(body);
      },
      stop: async (id: string, _query: unknown, options?: { signal?: AbortSignal }) => {
        state.stopped.push({ id, signal: options?.signal });
        return state.stop(id);
      },
    };
  }
  return { state, NotteClient, NotteAPIError };
});

vi.mock('notte-sdk', () => ({ NotteClient: sdk.NotteClient, NotteAPIError: sdk.NotteAPIError }));

const defaultStart = sdk.state.start;
const defaultStop = sdk.state.stop;
const defaultDebugInfo = sdk.state.debugInfo;

beforeEach(() => {
  Object.assign(sdk.state, { clients: [], started: [], stopped: [], counter: 0, start: defaultStart, stop: defaultStop, files: new Map(), listed: [], downloadSignals: [], downloadBody: undefined, debugInfo: defaultDebugInfo });
  runId = `run-${randomUUID()}`;
});

afterEach(() => {
  rmSync(path.join(tmpdir(), 'e2e-notte', runId), { recursive: true, force: true });
});

/** A fresh run per test: the provider keeps its run's open sessions on disk, under the run id. */
let runId = '';

/** Where the provider keeps the run's markers for target `web`, as `src/ledger.ts` builds it. */
const markerDir = (): string => path.join(tmpdir(), 'e2e-notte', runId, createHash('sha256').update('web').digest('hex').slice(0, 16));

const env = { NOTTE_API_KEY: 'n-test' };

function request(overrides: Partial<BrowserRequest> = {}): BrowserRequest & { lines: string[] } {
  const lines: string[] = [];
  return {
    runId,
    targetName: 'web',
    slot: 0,
    slots: 2,
    env,
    signal: new AbortController().signal,
    log: (line) => lines.push(line),
    lines,
    ...overrides,
  };
}

function releaseContext(): BrowserReleaseContext {
  return { runId, targetName: 'web', env, signal: new AbortController().signal, log: () => undefined };
}

function downloadContext(suggestedFilename: string, signal = new AbortController().signal): BrowserDownloadContext {
  return { runId, targetName: 'web', env, signal, suggestedFilename };
}

describe('notte()', () => {
  it('starts a session with the options as given and logs its console page, never the token-bearing viewer URL', async () => {
    const req = request({ attemptId: 'a1' });
    const provider = notte({ solve_captchas: true, idle_timeout_minutes: 5 });
    const lease = await provider.acquire(req);
    expect(lease).toEqual({ id: 's1', cdpEndpoint: 'wss://notte/s1' });
    expect(sdk.state.started).toEqual([{ body: { solve_captchas: true, idle_timeout_minutes: 5 }, signal: undefined }]);
    expect(req.lines).toEqual(['session s1, watch at https://console.notte.cc/sessions/s1']);
  });

  it('logs the session alone on another Notte API URL, whose console it does not know', async () => {
    const req = request({ env: { ...env, NOTTE_API_URL: 'https://staging.notte.cc' } });
    await notte().acquire(req);
    expect(req.lines).toEqual(['session s1']);
  });

  it('leases one session per attempt, since a Notte session refuses new browser contexts', () => {
    expect(notte().scope).toBe('attempt');
  });

  it("takes the CDP URL from the session's debug info when the start response has none, as the SDK does", async () => {
    sdk.state.start = async () => ({ session_id: 's9', status: 'active', cdp_url: null });
    sdk.state.debugInfo = async () => ({ ws: { cdp: 'wss://notte/debug/s9' } });
    await expect(notte().acquire(request())).resolves.toEqual({ id: 's9', cdpEndpoint: 'wss://notte/debug/s9' });
  });

  it('stops and fails a session with no CDP URL anywhere, and leaves it to the sweep when the stop fails', async () => {
    sdk.state.start = async () => ({ session_id: 's9', status: 'active', cdp_url: null });
    await expect(notte().acquire(request())).rejects.toThrow('session s9 started without a CDP URL; stopped');
    expect(sdk.state.stopped.map((stop) => stop.id)).toEqual(['s9']);
    sdk.state.stop = async () => {
      throw new Error('503 unavailable');
    };
    const provider = notte();
    await expect(provider.acquire(request())).rejects.toThrow("session s9 started without a CDP URL; stopping it failed, so the run's sweep");
    sdk.state.stop = defaultStop;
    await expect(provider.sweep!(releaseContext())).resolves.toEqual(['s9']);
  });

  it('stops and fails a session whose debug info request fails, rather than surfacing that error', async () => {
    sdk.state.start = async () => ({ session_id: 's9', status: 'active', cdp_url: null });
    sdk.state.debugInfo = async () => {
      throw new Error('debug info 502');
    };
    const provider = notte();
    await expect(provider.acquire(request())).rejects.toThrow('session s9 started without a CDP URL; stopped');
    expect(sdk.state.stopped.map((stop) => stop.id)).toEqual(['s9']);
    await expect(provider.sweep!(releaseContext())).resolves.toEqual([]);
  });

  it('records each session in a marker only the run user can read', async () => {
    await notte().acquire(request());
    expect(statSync(markerDir()).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(markerDir(), 's1')).mode & 0o777).toBe(0o600);
  });

  it('stops and fails a session it cannot record, instead of running one the sweep would not find', async () => {
    // A file where the run's directory goes makes the marker unwritable.
    mkdirSync(path.join(tmpdir(), 'e2e-notte'), { recursive: true });
    writeFileSync(path.join(tmpdir(), 'e2e-notte', runId), '');
    await expect(notte().acquire(request())).rejects.toThrow(/^session s1 could not be recorded for the run's sweep \(.+\); stopped$/);
    expect(sdk.state.stopped.map((stop) => stop.id)).toEqual(['s1']);
  });

  it('refuses a session id that is not one Notte issues before it names a file after it', async () => {
    sdk.state.start = async () => ({ session_id: '../escape', status: 'active', cdp_url: 'wss://notte/escape' });
    await expect(notte().acquire(request())).rejects.toThrow(`session ../escape could not be recorded for the run's sweep (session id "../escape" is not one Notte issues); stopped`);
    expect(sdk.state.stopped.map((stop) => stop.id)).toEqual(['../escape']);
    expect(existsSync(path.join(path.dirname(markerDir()), 'escape'))).toBe(false);
  });

  it('stops the session on release, and a session Notte already closed counts as stopped', async () => {
    const provider = notte();
    const lease = await provider.acquire(request());
    const context = releaseContext();
    await provider.release(lease, context);
    expect(sdk.state.stopped).toEqual([{ id: 's1', signal: context.signal }]);
    sdk.state.stop = async () => {
      throw new sdk.NotteAPIError(404, 'session not found');
    };
    await expect(provider.release(lease, releaseContext())).resolves.toBeUndefined();
    sdk.state.stop = async () => {
      throw new sdk.NotteAPIError(400, 'Session s1 is already closed');
    };
    await expect(provider.release(lease, releaseContext())).resolves.toBeUndefined();
  });

  it('surfaces any other stop failure, and a stop that left the session open', async () => {
    const provider = notte();
    const lease = await provider.acquire(request());
    sdk.state.stop = async () => {
      throw new sdk.NotteAPIError(500, 'internal');
    };
    await expect(provider.release(lease, releaseContext())).rejects.toThrow('internal');
    sdk.state.stop = async (id) => ({ session_id: id, status: 'active' });
    await expect(provider.release(lease, releaseContext())).rejects.toThrow('session s1 is still active after stop');
    // Both failed stops kept the marker, so the sweep still finds the session.
    sdk.state.stop = defaultStop;
    await expect(provider.sweep!(releaseContext())).resolves.toEqual(['s1']);
  });

  it('stops a session that arrived after the request was cancelled', async () => {
    const controller = new AbortController();
    sdk.state.start = async (body) => {
      controller.abort();
      return defaultStart(body);
    };
    const provider = notte();
    await expect(provider.acquire(request({ signal: controller.signal }))).rejects.toThrow('session s1 arrived after the request was cancelled; stopped');
    expect(sdk.state.stopped.map((stop) => stop.id)).toEqual(['s1']);
    // The confirmed stop removed the marker: the sweep has nothing left to stop.
    await expect(provider.sweep!(releaseContext())).resolves.toEqual([]);
    expect(sdk.state.stopped.map((stop) => stop.id)).toEqual(['s1']);
  });

  it('starts nothing for a request already cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('interrupted'));
    await expect(notte().acquire(request({ signal: controller.signal }))).rejects.toThrow('interrupted');
    expect(sdk.state.started).toEqual([]);
  });

  it('says so when a session that arrived after cancellation could not be stopped', async () => {
    const controller = new AbortController();
    sdk.state.start = async (body) => {
      controller.abort();
      return defaultStart(body);
    };
    sdk.state.stop = async () => {
      throw new Error('503 unavailable');
    };
    await expect(notte().acquire(request({ signal: controller.signal }))).rejects.toThrow(
      "session s1 arrived after the request was cancelled; stopping it failed, so the run's sweep or Notte's idle_timeout_minutes ends it: 503 unavailable",
    );
  });

  it('fails without an API key in the run environment and reuses one SDK client per key and API URL', async () => {
    const provider = notte();
    await expect(provider.acquire(request({ env: { NOTTE_API_KEY: '  ' } }))).rejects.toThrow('NOTTE_API_KEY is not set');
    await provider.acquire(request());
    await provider.acquire(request({ slot: 1 }));
    await provider.acquire(request({ env: { NOTTE_API_KEY: 'n-other' } }));
    await provider.acquire(request({ env: { NOTTE_API_KEY: 'n-test', NOTTE_API_URL: 'https://staging.notte.cc' } }));
    expect(sdk.state.clients).toEqual([{ apiKey: 'n-test' }, { apiKey: 'n-other' }, { apiKey: 'n-test', baseUrl: 'https://staging.notte.cc' }]);
  });

  describe('downloads', () => {
    const lease = { id: 's1', cdpEndpoint: 'wss://notte/s1' };
    const file = (id: string, filename: string, at: string, bytes: string) => ({ id, filename, created_at: at, bytes });
    const text = async (bytes: Promise<Uint8Array>) => new TextDecoder().decode(await bytes);

    it('has the browser save downloads where Notte collects them, and reads each by the name the site suggested', async () => {
      const provider = notte();
      expect(provider.downloads?.dir).toBe('/tmp/session-downloads');
      // The small file started second but finished first; names, not finish order, pair them.
      sdk.state.files.set('s1', [file('f2', 'big.zip', '2026-11-12T10:00:05Z', 'big'), file('f1', 'small.txt', '2026-11-12T10:00:01Z', 'small')]);
      expect(await text(provider.downloads!.read(lease, '/tmp/session-downloads/guid-1', downloadContext('big.zip')))).toBe('big');
      expect(await text(provider.downloads!.read(lease, '/tmp/session-downloads/guid-2', downloadContext('small.txt')))).toBe('small');
      expect(sdk.state.listed[0]).toEqual({ sessionId: 's1', query: { source: 'session_download', limit: 100, offset: 0 } });
      expect(sdk.state.downloadSignals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    });

    it('skips a download nobody waited for instead of handing its bytes to the next wait', async () => {
      const provider = notte();
      sdk.state.files.set('s1', [file('f1', 'unwaited.csv', '2026-11-12T10:00:01Z', 'stray'), file('f2', 'report.pdf', '2026-11-12T10:00:02Z', 'wanted')]);
      expect(await text(provider.downloads!.read(lease, '/tmp/session-downloads/guid', downloadContext('report.pdf')))).toBe('wanted');
    });

    it('reads two files of one name that share a time in reverse of Notte\'s newest-first listing', async () => {
      const provider = notte();
      // Notte lists newest first.
      sdk.state.files.set('s1', [file('f2', 'a.txt', '2026-11-12T10:00:01Z', 'second'), file('f1', 'a.txt', '2026-11-12T10:00:01Z', 'first')]);
      expect(await text(provider.downloads!.read(lease, '/tmp/session-downloads/g1', downloadContext('a.txt')))).toBe('first');
      expect(await text(provider.downloads!.read(lease, '/tmp/session-downloads/g2', downloadContext('a.txt')))).toBe('second');
    });

    it('reads two files of one name oldest first by their time, whatever order Notte lists them in', async () => {
      const provider = notte();
      sdk.state.files.set('s1', [file('f1', 'a.txt', '2026-11-12T10:00:01Z', 'older'), file('f2', 'a.txt', '2026-11-12T10:00:05Z', 'newer')]);
      expect(await text(provider.downloads!.read(lease, '/tmp/session-downloads/g1', downloadContext('a.txt')))).toBe('older');
      expect(await text(provider.downloads!.read(lease, '/tmp/session-downloads/g2', downloadContext('a.txt')))).toBe('newer');
    });

    it('pages through every stored file, so an old download behind 100 newer ones is still found', async () => {
      const provider = notte();
      const newer = Array.from({ length: 150 }, (_, index) => file(`n${index}`, `other-${index}.txt`, `2026-11-12T11:${String(index % 60).padStart(2, '0')}:00Z`, 'other'));
      sdk.state.files.set('s1', [...newer, file('old', 'wanted.txt', '2026-11-12T10:00:00Z', 'wanted')]);
      expect(await text(provider.downloads!.read(lease, '/tmp/session-downloads/guid', downloadContext('wanted.txt')))).toBe('wanted');
      expect(sdk.state.listed.map(({ query }) => (query as { offset: number }).offset)).toEqual([0, 100]);
    });

    it('fails a file read that brings back no file body', async () => {
      const provider = notte();
      sdk.state.files.set('s1', [file('f1', 'a.txt', '2026-11-12T10:00:01Z', 'bytes')]);
      sdk.state.downloadBody = { not: 'a blob' };
      await expect(provider.downloads!.read(lease, '/tmp/session-downloads/guid', downloadContext('a.txt'))).rejects.toThrow('Notte answered file f1 of session s1 with no file body');
    });

    it('waits for a download Notte has not collected yet, and gives up when the wait is cancelled', async () => {
      const provider = notte();
      setTimeout(() => sdk.state.files.set('s1', [file('f1', 'late.txt', '2026-11-12T10:00:01Z', 'late')]), 700);
      expect(await text(provider.downloads!.read(lease, '/tmp/session-downloads/guid', downloadContext('late.txt')))).toBe('late');
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      await expect(provider.downloads!.read(lease, '/tmp/session-downloads/guid-2', downloadContext('other.txt', controller.signal))).rejects.toThrow(
        "download /tmp/session-downloads/guid-2 never reached session s1's file storage",
      );
    });
  });

  describe('sweep', () => {
    it('stops the sessions of the run a dead worker never released, and only those', async () => {
      const provider = notte();
      const released = await provider.acquire(request());
      await provider.acquire(request({ slot: 1 }));
      await provider.release(released, releaseContext());
      sdk.state.stopped = [];
      await expect(provider.sweep!(releaseContext())).resolves.toEqual(['s2']);
      expect(sdk.state.stopped.map((stop) => stop.id)).toEqual(['s2']);
      await expect(provider.sweep!(releaseContext())).resolves.toEqual([]);
    });

    it("never touches another run's sessions", async () => {
      const provider = notte();
      await provider.acquire(request());
      const other = { ...releaseContext(), runId: `run-${randomUUID()}` };
      await expect(provider.sweep!(other)).resolves.toEqual([]);
      expect(sdk.state.stopped).toEqual([]);
      await provider.sweep!(releaseContext());
    });

    it('stops every session it found even when one stop fails, names both, and names only the ones Notte still had open', async () => {
      const provider = notte();
      await provider.acquire(request());
      await provider.acquire(request({ slot: 1 }));
      await provider.acquire(request({ slot: 2 }));
      sdk.state.stop = async (id) => {
        if (id === 's2') throw new sdk.NotteAPIError(500, 'internal');
        if (id === 's3') throw new sdk.NotteAPIError(404, 'gone');
        return { session_id: id, status: 'closed' };
      };
      await expect(provider.sweep!(releaseContext())).rejects.toThrow('stopped s1; could not stop s2 (internal), so Notte ends it after idle_timeout_minutes');
      expect(sdk.state.stopped.map((stop) => stop.id).toSorted()).toEqual(['s1', 's2', 's3']);
      // Only the failed stop's marker is left.
      sdk.state.stop = defaultStop;
      sdk.state.stopped = [];
      await expect(provider.sweep!(releaseContext())).resolves.toEqual(['s2']);
      expect(sdk.state.stopped.map((stop) => stop.id)).toEqual(['s2']);
    });

    it('surfaces a marker directory it cannot read rather than report no sessions', async () => {
      mkdirSync(path.dirname(markerDir()), { recursive: true });
      writeFileSync(markerDir(), '');
      await expect(notte().sweep!(releaseContext())).rejects.toThrow(/ENOTDIR: not a directory, scandir/);
    });

    it('removes the run\'s marker directories once every session is stopped', async () => {
      const provider = notte();
      await provider.acquire(request());
      await expect(provider.sweep!(releaseContext())).resolves.toEqual(['s1']);
      expect(existsSync(path.join(tmpdir(), 'e2e-notte', runId))).toBe(false);
    });
  });
});
