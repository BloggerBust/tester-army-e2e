/** How a target resolves when its `app.url` is a file: no host, so no site, origin, port, or readiness poll. */

import { describe, expect, it } from 'vitest';
import { web } from '@e2e-dev/web';
import { defineEngine } from '@e2e-dev/core/lib/engine/index';
import { snapshot } from '../helpers/snapshot.ts';
import { checkTargetApp, engineAppInfo, resolveTargetApp, type ResolvedApp } from '@e2e-dev/core/lib/config/app';

const url = 'file:///tmp/e2e-file-app/site/index.html';

/** An engine that declares it opens a file app. */
const fileEngine = defineEngine({ name: 'files', version: '1.0.0', spiVersion: 1, fileApps: true, observe: async () => snapshot([]) });

/** The app a target named `web` resolves to from what its config declares. */
const resolve = (declared: object): ResolvedApp => resolveTargetApp('web', checkTargetApp('web', fileEngine, declared), '/tmp/project');

describe('a file app.url', () => {
  it('resolves with no site or origin, as a test environment, identified by the file', () => {
    const app = resolve({ url });
    expect(app.base?.href).toBe(url);
    expect(app.site).toBeUndefined();
    expect(app.environment).toBe('test');
    expect(app.identity).toBe(url);
    expect(app.portRequest).toBeUndefined();
    expect(engineAppInfo(app)).toEqual({});
  });

  it('keeps the origin and site of an http app', () => {
    const app = resolve({ url: 'https://app.example.com/shop' });
    expect(engineAppInfo(app)).toEqual({ origin: 'https://app.example.com', site: 'example.com' });
    expect(app.identity).toBe('https://app.example.com/shop');
  });

  it('needs a readyUrl beside a command, since a file answers no poll', () => {
    const command = { executable: 'npm', args: ['run', 'api'] };
    expect(() => resolve({ url, command })).toThrowError(
      expect.objectContaining({ code: 'APP_URL_REQUIRED', message: expect.stringContaining('a file answers no readiness poll: declare app.readyUrl') }),
    );
    expect(resolve({ url, command, readyUrl: 'http://localhost:4000/health' }).readyUrl).toBe('http://localhost:4000/health');
  });

  it('is refused for an engine that does not declare it opens one', () => {
    const plain = defineEngine({ name: 'plain', version: '1.0.0', spiVersion: 1, observe: async () => snapshot([]) });
    expect(() => checkTargetApp('web', plain, { url })).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('engine "plain" does not declare that it opens one from this machine\'s disk') }),
    );
    expect(() => checkTargetApp('web', plain, { url: 'https://app.example.com' })).not.toThrow();
  });

  it('tells the engine it is a file app, by the harness\'s own reading of the URL', () => {
    const seen: unknown[] = [];
    const engine = defineEngine({ name: 'files', version: '1.0.0', spiVersion: 1, fileApps: true, observe: async () => snapshot([]), validateApp: (_app, info) => void seen.push(info) });
    checkTargetApp('web', engine, { url });
    checkTargetApp('web', engine, { url: 'FILE:/tmp/e2e-file-app/site/index.html' });
    checkTargetApp('web', engine, { url: 'https://app.example.com' });
    // `file:8443/report` is the host `file` on port 8443, as it was before file apps.
    checkTargetApp('web', engine, { url: 'file:8443/report' });
    expect(seen).toEqual([{ targetName: 'web', fileApp: true }, { targetName: 'web', fileApp: true }, { targetName: 'web' }, { targetName: 'web' }]);
  });

  it('keeps a host named file an https app, with the web engine\'s headers', () => {
    const app = resolveTargetApp('web', checkTargetApp('web', web({ headers: { 'x-preview': 'synthetic' } }), { url: 'file:8443/report' }), '/tmp/project');
    expect(app.base?.href).toBe('https://file:8443/report');
    expect(engineAppInfo(app)).toMatchObject({ origin: 'https://file:8443' });
  });

  it('refuses {port} in a command, having no port to give', () => {
    expect(() => resolve({ url, readyUrl: 'http://localhost:4000', command: { executable: 'serve', args: ['-p', '{port}'] } })).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIG' }),
    );
  });
});
