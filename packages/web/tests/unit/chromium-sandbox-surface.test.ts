/** The surface hands its launch the `chromiumSandbox` option, or the platform default without one. */
import type { Browser } from 'playwright-core';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultChromiumSandbox } from '../../src/browser-connection.ts';
import { PlaywrightSurface, type WebOptions } from '../../src/surface.ts';

const acquire = vi.hoisted(() => vi.fn());
vi.mock('../../src/browser-connection.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/browser-connection.ts')>()),
  BrowserConnection: class {
    acquire = acquire;
    dispose = async () => undefined;
  },
}));

let surfaces: PlaywrightSurface[] = [];

async function launchedSandbox(options: WebOptions): Promise<unknown> {
  acquire.mockReset();
  acquire.mockResolvedValue({} as unknown as Browser);
  const surface = new PlaywrightSurface(options);
  surfaces.push(surface);
  await surface.init({
    runId: 'run',
    targetName: 'web',
    projectRoot: process.cwd(),
    app: {},
    env: {},
    headed: false,
    workerSlot: 0,
    signal: new AbortController().signal,
    log: () => undefined,
  });
  expect(acquire).toHaveBeenCalledOnce();
  return (acquire.mock.calls[0]![0] as { chromiumSandbox: unknown }).chromiumSandbox;
}

afterEach(async () => {
  for (const surface of surfaces) {
    await surface.dispose({ timeoutMs: 1_000, signal: new AbortController().signal });
  }
  surfaces = [];
});

it('launches with the platform default when the option is omitted', async () => {
  await expect(launchedSandbox({})).resolves.toBe(defaultChromiumSandbox());
});

it('launches with what the option says', async () => {
  await expect(launchedSandbox({ chromiumSandbox: false })).resolves.toBe(false);
  await expect(launchedSandbox({ chromiumSandbox: true })).resolves.toBe(true);
});
