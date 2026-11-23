import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeDebugWarning } from '../../src/run/node-debug.ts';

const prints = (...on: string[]) => (section: string): boolean => on.includes(section);

describe('the NODE_DEBUG warning', () => {
  it('warns by what Node prints, not by the variable: one cleared since startup changes nothing', () => {
    expect(nodeDebugWarning(undefined, prints('child_process'))).toBe(
      'e2e: NODE_DEBUG, as this process started with it, makes Node print the environment of every process e2e starts; in output e2e writes, its secrets and the provider keys it knows are redacted there, and every other token or password is printed as it is, so start without NODE_DEBUG unless you are debugging with it',
    );
    expect(nodeDebugWarning(undefined, prints())).toBeUndefined();
  });

  it('says nothing when no section that prints credentials is on', () => {
    expect(nodeDebugWarning('http,fetch', prints('http', 'fetch'))).toBeUndefined();
    expect(nodeDebugWarning('', prints())).toBeUndefined();
  });

  it('names the variable as set and the environment for child_process', () => {
    expect(nodeDebugWarning('CHILD*', prints('child_process'))).toBe(
      'e2e: NODE_DEBUG=CHILD* makes Node print the environment of every process e2e starts; in output e2e writes, its secrets and the provider keys it knows are redacted there, and every other token or password is printed as it is, so start without NODE_DEBUG unless you are debugging with it',
    );
  });

  it('names the request headers for net', () => {
    expect(nodeDebugWarning('net', prints('net'))).toBe(
      'e2e: NODE_DEBUG=net makes Node print the headers of requests made with node:http; in output e2e writes, its secrets and the provider keys it knows are redacted there, and every other token or password is printed as it is, so start without NODE_DEBUG unless you are debugging with it',
    );
  });

  it('names both when both are on', () => {
    expect(nodeDebugWarning('*', prints('child_process', 'net', 'http'))).toContain(
      'makes Node print the environment of every process e2e starts and the headers of requests made with node:http; in output e2e writes,',
    );
  });
});

describe('warning of NODE_DEBUG', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('writes the warning to stderr once, however many runs the process starts', async () => {
    vi.resetModules();
    const fresh = await import('../../src/run/node-debug.ts');
    vi.stubEnv('NODE_DEBUG', 'child_process');
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    fresh.warnOfNodeDebug(prints('child_process'));
    fresh.warnOfNodeDebug(prints('child_process'));
    expect(written).toEqual([`${fresh.nodeDebugWarning('child_process', prints('child_process'))}\n`]);
  });

  it('writes nothing when Node prints no credentials', async () => {
    vi.resetModules();
    const fresh = await import('../../src/run/node-debug.ts');
    vi.stubEnv('NODE_DEBUG', 'http');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    fresh.warnOfNodeDebug(prints());
    expect(write).not.toHaveBeenCalled();
  });
});
