/** A Chromium launch takes the sandbox value it is asked for, and a sandbox that cannot start names the option. */
import type { Browser } from 'playwright-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserConnection, defaultChromiumSandbox, type BrowserAcquireOptions } from '../../src/browser-connection.ts';
import { web } from '../../src/engine.ts';

const chromiumLaunch = vi.hoisted(() => vi.fn());
const firefoxLaunch = vi.hoisted(() => vi.fn());
const webkitLaunch = vi.hoisted(() => vi.fn());
vi.mock('playwright-core', () => ({
  chromium: { launch: chromiumLaunch },
  firefox: { launch: firefoxLaunch },
  webkit: { launch: webkitLaunch },
  selectors: { register: vi.fn() },
}));

/** A browser that reports itself connected, with the `close` its owner is expected to call. */
function fakeBrowser(connected: () => boolean = () => true) {
  const close = vi.fn(async () => undefined);
  return { browser: { isConnected: connected, close } as unknown as Browser, close };
}

function launch(chromiumSandbox: boolean, overrides: Partial<BrowserAcquireOptions> = {}): BrowserAcquireOptions {
  return { name: 'chromium', headed: false, timeoutMs: 1_000, chromiumSandbox, ...overrides };
}

/** The single launch options object a mocked browser type was called with. */
function launchOf(type: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const calls = (type as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0]![0] as Record<string, unknown>;
}

describe('BrowserConnection', () => {
  beforeEach(() => {
    chromiumLaunch.mockReset();
    firefoxLaunch.mockReset();
    webkitLaunch.mockReset();
  });

  it('launches chromium with the sandbox on when asked', async () => {
    const { browser } = fakeBrowser();
    chromiumLaunch.mockResolvedValue(browser);
    const connection = new BrowserConnection();
    await connection.acquire(launch(true));
    expect(launchOf(chromiumLaunch)).toEqual({
      headless: true,
      timeout: 1_000,
      handleSIGINT: false,
      handleSIGTERM: false,
      chromiumSandbox: true,
    });
    await connection.dispose();
  });

  it('launches chromium with the sandbox off when asked', async () => {
    const { browser } = fakeBrowser();
    chromiumLaunch.mockResolvedValue(browser);
    const connection = new BrowserConnection();
    await connection.acquire(launch(false));
    expect(launchOf(chromiumLaunch)).toMatchObject({ chromiumSandbox: false });
    await connection.dispose();
  });

  it('keeps the sandbox on when a waiter joins a relaunch that is still in flight', async () => {
    let connected = true;
    const { browser: first } = fakeBrowser(() => connected);
    const { browser: third } = fakeBrowser();
    chromiumLaunch
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(
        () =>
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('browserType.launch: Chromium sandboxing failed!')), 20);
          }),
      )
      .mockResolvedValueOnce(third);
    const connection = new BrowserConnection();
    await connection.acquire(launch(true));
    connected = false;
    // The relaunch is still in flight when the waiter joins it, so the
    // waiter goes through the re-acquire once: a flip there cannot cancel
    // out against a second one.
    const relaunch = connection.acquire(launch(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const waiter = connection.acquire(launch(true));
    const [relaunchResult, waiterResult] = await Promise.allSettled([relaunch, waiter]);
    expect(relaunchResult.status).toBe('rejected');
    expect(waiterResult.status).toBe('fulfilled');
    expect(chromiumLaunch).toHaveBeenCalledTimes(3);
    expect(chromiumLaunch.mock.calls.map((call) => (call[0] as { chromiumSandbox: unknown }).chromiumSandbox)).toEqual([true, true, true]);
    await connection.dispose();
  });

  it('turns a sandbox launch failure into an error naming the option', async () => {
    chromiumLaunch.mockRejectedValueOnce(
      new Error(
        'browserType.launch: Target page, context or browser has been closed\n' +
          'Chromium sandboxing failed!\n' +
          'Call log:\n' +
          '  - launching Chromium with --no-sandbox --flag-a --flag-b',
      ),
    );
    const connection = new BrowserConnection();
    let error: (Error & { code?: unknown; cause?: unknown; retryable?: unknown }) | undefined;
    try {
      await connection.acquire(launch(true));
    } catch (caught) {
      error = caught as Error & { code?: unknown; cause?: unknown; retryable?: unknown };
    }
    expect(error?.code).toBe('ENGINE_FAILURE');
    expect(error?.retryable).toBe(false);
    expect(error?.message).toContain('web({ chromiumSandbox: false })');
    expect(error?.message).not.toContain('Call log');
    expect(error?.message).not.toContain('--flag-a');
    expect(error?.cause).toBeUndefined();
    await connection.dispose();
  });

  it('passes any other launch failure through unchanged', async () => {
    const failure = new Error('browserType.launch: executable does not exist');
    chromiumLaunch.mockRejectedValueOnce(failure);
    const connection = new BrowserConnection();
    await expect(
      connection.acquire(launch(true)),
    ).rejects.toBe(failure);
    await connection.dispose();
  });

  it('does not pass the chromium-only option to firefox or webkit', async () => {
    const { browser } = fakeBrowser();
    firefoxLaunch.mockResolvedValue(browser);
    webkitLaunch.mockResolvedValue(browser);
    const connection = new BrowserConnection();
    await connection.acquire(launch(true, { name: 'firefox' }));
    await connection.dispose();
    expect(launchOf(firefoxLaunch)).not.toHaveProperty('chromiumSandbox');
    const second = new BrowserConnection();
    await second.acquire(launch(true, { name: 'webkit' }));
    await second.dispose();
    expect(launchOf(webkitLaunch)).not.toHaveProperty('chromiumSandbox');
  });
});

describe('defaultChromiumSandbox', () => {
  it('is on where the sandbox starts out of the box and off on Linux', () => {
    expect(defaultChromiumSandbox('darwin')).toBe(true);
    expect(defaultChromiumSandbox('win32')).toBe(true);
    expect(defaultChromiumSandbox('linux')).toBe(false);
  });
});

describe('web({ chromiumSandbox })', () => {
  it('rejects a value that is not a boolean as INVALID_CONFIG', () => {
    expect(() => web({ chromiumSandbox: 'yes' as unknown as boolean })).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('must be a boolean') }));
  });

  it('accepts true and false', () => {
    expect(() => web({ chromiumSandbox: true })).not.toThrow();
    expect(() => web({ chromiumSandbox: false })).not.toThrow();
  });
});
