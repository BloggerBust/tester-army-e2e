/** Platform browser command formatting and detached spawn error handling. */

import { describe, expect, it } from 'vitest';
import { platformOpenCommand, spawnBrowserCommand } from '../../src/internal/open-browser.ts';

describe('open-browser', () => {
  it('builds safe per-OS opener commands without invoking a shell', () => {
    expect(platformOpenCommand('win32', 'file:///C:/a/report.html')).toEqual({
      command: 'rundll32',
      args: ['url.dll,FileProtocolHandler', 'file:///C:/a/report.html'],
    });
    expect(platformOpenCommand('darwin', 'file:///tmp/report.html')).toEqual({
      command: 'open',
      args: ['file:///tmp/report.html'],
    });
    expect(platformOpenCommand('linux', 'file:///tmp/report.html')).toEqual({
      command: 'xdg-open',
      args: ['file:///tmp/report.html'],
    });
  });

  it('reports launcher spawn failures through onError instead of throwing', async () => {
    const cause = await new Promise<unknown>((resolve) => {
      spawnBrowserCommand(
        { command: 'nonexistent-e2e-browser-opener-binary', args: ['file:///tmp/report.html'] },
        resolve,
      );
    });
    expect(cause).toBeInstanceOf(Error);
  });
});
