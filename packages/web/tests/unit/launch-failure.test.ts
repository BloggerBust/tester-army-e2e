/** What the surface reports when the browser does not come up: the missing system libraries on a launch, and the failure's own reason. */
import { EngineError } from '@e2e-dev/core/engine';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PlaywrightSurface, type WebOptions } from '../../src/surface.ts';

const acquire = vi.hoisted(() => vi.fn());
const missingBrowserLibraries = vi.hoisted(() => vi.fn());
vi.mock('../../src/browser-connection.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/browser-connection.ts')>()),
  BrowserConnection: class {
    acquire = acquire;
    dispose = async () => undefined;
  },
}));
vi.mock('../../src/install.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/install.ts')>()),
  missingBrowserLibraries,
}));

const LAUNCH_ERROR = 'browserType.launch: Cannot launch Firefox with relative home directory. Did you set HOME to a relative path?\nCall log:\n  - <launching> firefox';

let surfaces: PlaywrightSurface[] = [];

/** The error `init` rejects with when the browser never comes up. */
async function initFailure(options: WebOptions, signal: AbortSignal = new AbortController().signal, headed = false): Promise<EngineError> {
  const surface = new PlaywrightSurface(options);
  surfaces.push(surface);
  const failure: unknown = await surface
    .init({ runId: 'run', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed, workerSlot: 0, signal, log: () => undefined })
    .then(
      () => undefined,
      (cause: unknown) => cause,
    );
  if (!(failure instanceof EngineError)) throw new Error(`init did not fail with an engine error: ${String(failure)}`);
  return failure;
}

beforeEach(() => {
  acquire.mockReset();
  acquire.mockRejectedValue(new Error(LAUNCH_ERROR));
  missingBrowserLibraries.mockReset();
  missingBrowserLibraries.mockResolvedValue([]);
});

afterEach(async () => {
  for (const surface of surfaces) await surface.dispose({ timeoutMs: 1_000, signal: new AbortController().signal });
  surfaces = [];
});

it('names the missing libraries and the install that adds them, then the reason the launch gave', async () => {
  missingBrowserLibraries.mockResolvedValue(['libnss3.so', 'libgbm.so.1']);
  const failure = await initFailure({ browser: 'firefox' });
  expect(failure.code).toBe('ENGINE_FAILURE');
  expect(failure.retryable).toBe(false);
  expect(failure.message).toBe(
    `browser launch failed: firefox cannot launch: 2 system libraries are missing (libnss3.so, libgbm.so.1); run "npx @e2e-dev/web install firefox --with-deps" (pnpm: "pnpm exec e2e-web install firefox --with-deps")\nlaunch error: ${LAUNCH_ERROR}`,
  );
  expect(failure.cause).toMatchObject({ message: LAUNCH_ERROR });
});

it('names one missing library the same way', async () => {
  missingBrowserLibraries.mockResolvedValue(['libnss3.so']);
  expect((await initFailure({})).message).toMatch(/^browser launch failed: chromium cannot launch: a system library is missing \(libnss3\.so\); .*\nlaunch error: browserType\.launch: Cannot launch Firefox/);
});

it('keeps the whole launch error when every library resolves', async () => {
  expect((await initFailure({})).message).toBe(`browser launch failed: ${LAUNCH_ERROR}`);
});

it('probes the build the failed launch used, bounded by the init signal', async () => {
  const controller = new AbortController();
  await initFailure({ browser: 'firefox' }, controller.signal, true);
  expect(missingBrowserLibraries.mock.calls).toEqual([['firefox', process.env, true, { signal: controller.signal }]]);
});

it('does not probe this machine when the browser it could not reach runs elsewhere', async () => {
  missingBrowserLibraries.mockResolvedValue(['libnss3.so']);
  const failure = await initFailure({ connect: { cdpEndpoint: () => 'http://127.0.0.1:9222' } });
  expect(failure.message).toBe(`browser connect failed: ${LAUNCH_ERROR}`);
  expect(missingBrowserLibraries).not.toHaveBeenCalled();
});
