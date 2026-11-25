/** The app under test is the target's: `web()` checks the target's `app` for what a browser needs. */

import { describe, expect, it } from 'vitest';
import { web } from '../../src/index.ts';
import { grantedPermissions, grantPermissions } from '../../src/permissions.ts';

describe('web() and the target app', () => {
  it('needs app.url on the target, and refuses the fields of an installed device app', () => {
    const { validateApp } = web();
    const info = { targetName: 'chromium' };
    expect(() => validateApp!({ url: 'http://localhost:3000' }, info)).not.toThrow();
    expect(() => validateApp!({}, info)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('target "chromium" needs app.url') }),
    );
    for (const key of ['bundleId', 'appPath', 'launchArguments'] as const) {
      expect(() => validateApp!({ url: 'http://localhost:3000', [key]: key === 'launchArguments' ? ['-x'] : 'x' }, info)).toThrowError(
        expect.objectContaining({ message: `target "chromium" declares app.${key}, which describes an installed device app; a web() target opens app.url` }),
      );
    }
  });

  it('declares that it opens a file app, in a browser it launches itself and with no credentials to scope', () => {
    // The harness reads the URL and says so; the engine never parses the scheme itself.
    const info = { targetName: 'web', fileApp: true };
    const url = 'file:///tmp/site/index.html';
    const refused = (message: string) => expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining(message) });
    for (const browser of ['chromium', 'firefox', 'webkit'] as const) {
      expect(web({ browser }).fileApps).toBe(true);
      expect(() => web({ browser }).validateApp!({ url }, info)).not.toThrow();
    }
    const hosted = { name: 'hosted', acquire: async () => ({ id: 's', cdpEndpoint: 'ws://localhost:9222' }), release: async () => undefined };
    expect(() => web({ browser: hosted }).validateApp!({ url }, info)).toThrowError(
      refused('target "web" opens a file app.url, which browser provider "hosted" cannot read'),
    );
    expect(() => web({ connect: { cdpEndpoint: () => 'ws://localhost:9222' } }).validateApp!({ url }, info)).toThrowError(
      refused('web({ connect }) attaches to a browser that may run on another machine'),
    );
    expect(() => web({ headers: { 'x-preview': 'synthetic' } }).validateApp!({ url }, info)).toThrowError(
      refused("web({ headers }) always goes to the app's origin, which a file does not have"),
    );
    expect(() => web({ basicAuth: { username: 'user', password: 'synthetic' } }).validateApp!({ url }, info)).toThrowError(
      refused("web({ basicAuth }) always goes to the app's origin, which a file does not have"),
    );
    // A host named `file` is not a file app: the harness says nothing, and the options stand.
    expect(() => web({ browser: hosted, headers: { 'x-preview': 'synthetic' } }).validateApp!({ url: 'file:8443/report' }, { targetName: 'web' })).not.toThrow();
  });

  it('takes the permissions its browser grants, and grants only', () => {
    const info = { targetName: 'web' };
    const url = 'http://localhost:3000';
    const refused = (message: string) => expect.objectContaining({ code: 'INVALID_CONFIG', message });
    expect(() => web().validateApp!({ url, permissions: { 'clipboard-read': 'grant', 'clipboard-write': 'grant' } }, info)).not.toThrow();
    expect(() => web({ browser: 'webkit' }).validateApp!({ url, permissions: { 'clipboard-read': 'grant' } }, info)).not.toThrow();
    expect(() => web({ browser: 'firefox' }).validateApp!({ url, permissions: { 'clipboard-read': 'grant' } }, info)).toThrowError(
      refused(expect.stringContaining('target "web" app.permissions on firefox has unknown key "clipboard-read"')),
    );
    expect(() => web().validateApp!({ url, permissions: { 'clipboard-wirte': 'grant' } }, info)).toThrowError(
      refused(expect.stringContaining('did you mean "clipboard-write"')),
    );
    for (const state of ['deny', 'reset'] as const) {
      expect(() => web().validateApp!({ url, permissions: { camera: state } }, info)).toThrowError(
        refused(`target "web" app.permissions.camera is ${state}, but a web() target only grants; leave the permission out instead`),
      );
    }
  });

  it('takes \'all\' on every browser, granting each permission that browser grants', () => {
    for (const browser of ['chromium', 'firefox', 'webkit'] as const) {
      expect(() => web({ browser }).validateApp!({ url: 'http://localhost:3000', allPermissions: true }, { targetName: 'web' })).not.toThrow();
    }
    expect(grantedPermissions('firefox', { allPermissions: true })).toEqual(['geolocation', 'local-network-access', 'notifications', 'persistent-storage', 'push', 'screen-wake-lock']);
    expect(grantedPermissions('chromium', { allPermissions: true })).toContain('clipboard-read');
    expect(grantedPermissions('webkit', { permissions: { camera: 'grant' } })).toEqual(['camera']);
    expect(grantedPermissions('webkit', {})).toEqual([]);
    expect(web().grantsAllPermissions).toBe(true);
  });

  it("leaves out, for 'all' only, a permission an older browser refuses as unknown, and grants the rest", async () => {
    /**
     * A context on a browser that knows every type but `localNetworkAccess`, the way Chrome 134 answers over
     * CDP. Like Playwright's, it adds the names to the context's grants before it sends them, so a refused
     * name stays until the grants are cleared.
     */
    const olderChrome = () => {
      let held: string[] = [];
      const sent: string[][] = [];
      return {
        sent,
        async grantPermissions(names: string[]) {
          held = [...new Set([...held, ...names])];
          if (held.includes('local-network-access')) throw new Error('browserContext.grantPermissions: Unknown permission type: localNetworkAccess');
          sent.push(held);
        },
        async clearPermissions() {
          held = [];
        },
      };
    };
    const all = grantedPermissions('chromium', { allPermissions: true });
    const context = olderChrome();
    await grantPermissions(context, all, true);
    expect(context.sent).toEqual([all.filter((name) => name !== 'local-network-access')]);
    // A named grant keeps the browser's refusal: the user can leave the name out.
    await expect(grantPermissions(olderChrome(), ['geolocation', 'local-network-access'], false)).rejects.toThrow('Unknown permission type: localNetworkAccess');
    // Any other failure is not an unknown name to skip.
    const broken = { grantPermissions: async () => { throw new Error('Target page, context or browser has been closed'); }, clearPermissions: async () => {} };
    await expect(grantPermissions(broken, all, true)).rejects.toThrow('has been closed');
  });
});
