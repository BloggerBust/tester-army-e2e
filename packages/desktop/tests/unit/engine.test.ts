import { describe, expect, it } from 'vitest';
import { desktop } from '../../src/engine.ts';
import { resolveOptions } from '../../src/options.ts';

describe('desktop()', () => {
  it('offers the pointer-only actions, and keys, with headed alone', () => {
    const plain = desktop();
    const headed = desktop({ headed: true });
    expect(plain.actions).not.toContain('doubleTap');
    expect(plain.actions).not.toContain('hover');
    // agent-desktop sends a key only to the active window, which an app in the background never has.
    expect(plain.actions).not.toContain('press');
    expect(plain.pointerActions).toBeUndefined();
    expect(headed.actions).toEqual(expect.arrayContaining(['doubleTap', 'hover', 'press']));
    expect(headed.pointerActions).toEqual(expect.arrayContaining(['tap']));
    expect(plain.workers).toBe(1);
    expect(plain.keyboard).toBeUndefined();
    expect(headed.keyboard).toBeDefined();
  });

  it('refuses options it does not take', () => {
    expect(() => resolveOptions({ settle: 1.5 })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => resolveOptions({ binary: '' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => resolveOptions({ snapshot: 'all' as never })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => resolveOptions({ bogus: 1 } as never)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(resolveOptions({ settle: false })).toMatchObject({ settleMs: 0, headed: false, interactiveOnly: false });
    expect(resolveOptions({})).toMatchObject({ maxDepth: 24 });
    expect(resolveOptions({ maxDepth: 50 })).toMatchObject({ maxDepth: 50 });
    for (const maxDepth of [0, 51, 2.5]) expect(() => resolveOptions({ maxDepth })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => resolveOptions(null as unknown as undefined)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('refuses an app it cannot launch', () => {
    const engine = desktop();
    const check = (app: Record<string, unknown>) => () => engine.validateApp?.(app, { targetName: 'mac' });
    expect(check({ url: 'http://localhost:3000' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(check({})).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(check({ bundleId: 'com.example.app', permissions: { camera: 'grant' } })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(check({ bundleId: 'com.example.app' })).not.toThrow();
    expect(check({ appPath: 'build/App.zip' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(check({ appPath: 'build/App.app' })).not.toThrow();
  });

  it.skipIf(process.platform === 'darwin')('loads anywhere, and refuses to start a target on any OS but macOS', async () => {
    const engine = desktop();
    expect(engine.platform).toBe('macos');
    await expect(Promise.resolve().then(() => engine.prepare?.({} as never))).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(Promise.resolve().then(() => engine.init?.({} as never))).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });
});
