import { describe, expect, it } from 'vitest';
import { defineEngine } from '@e2e-dev/core/lib/engine/index';
import { assignPorts } from '@e2e-dev/core/lib/config/resolve';
import { resolveConfig } from '../../src/config/resolve-run.ts';
import { declaredCommands } from '@e2e-dev/core/lib/run/declared-processes';
import type { TargetApp } from '@e2e-dev/core/lib/types';
import { snapshot } from '../helpers/snapshot.ts';

const ROOT = '/tmp/e2e-declared-processes';

/** Resolves one target per app declaration, named t0, t1, ..., the way two browsers on one app would be configured. */
function configOf(...apps: TargetApp[]) {
  return resolveConfig(
    {
      targets: apps.map((app, index) => ({
        name: `t${index}`,
        platform: 'web',
        engine: defineEngine({ name: 'fake', version: '1.0.0', spiVersion: 1, observe: async () => snapshot([]) }),
        app,
      })),
    },
    { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv },
  );
}

const dev = { executable: 'pnpm', args: ['dev'] };

describe('declaredCommands', () => {
  it('starts identical commands once, in target order, probing the first readyUrl', () => {
    const commands = declaredCommands(
      configOf(
        { url: 'http://localhost:3000', command: dev },
        { url: 'http://localhost:3000/admin', command: dev },
        { url: 'http://localhost:4000', command: { executable: 'pnpm', args: ['api'] } },
      ).targets,
      new Map(),
    );
    expect(commands).toEqual([
      { label: 'target "t0" command', command: dev, readyUrl: 'http://localhost:3000/', key: expect.any(String), targetNames: ['t0', 't1'] },
      { label: 'target "t2" command', command: { executable: 'pnpm', args: ['api'] }, readyUrl: 'http://localhost:4000/', key: expect.any(String), targetNames: ['t2'] },
    ]);
    expect(declaredCommands(configOf({ url: 'http://localhost:3000' }, {}).targets, new Map())).toEqual([]);
  });

  it('dedupes commands on their expanded values once ports are assigned', () => {
    const shared: TargetApp = {
      url: 'http://127.0.0.1:0',
      command: { executable: 'pnpm', args: ['dev', '--port', '{port}'], env: { PORT: '{port}' } },
    };
    const onePort = declaredCommands(assignPorts(configOf(shared, shared), { t0: 4321, t1: 4321 }).targets, new Map());
    expect(onePort).toEqual([
      {
        label: 'target "t0" command',
        command: { executable: 'pnpm', args: ['dev', '--port', '4321'], env: { PORT: '4321' } },
        readyUrl: 'http://127.0.0.1:4321/',
        key: expect.any(String),
        targetNames: ['t0', 't1'],
      },
    ]);
    // Two ports are two servers, each probed where it listens.
    const twoPorts = declaredCommands(assignPorts(configOf(shared, shared), { t0: 4321, t1: 4322 }).targets, new Map());
    expect(twoPorts.map((command) => command.readyUrl)).toEqual(['http://127.0.0.1:4321/', 'http://127.0.0.1:4322/']);
    expect(twoPorts.map((command) => command.targetNames)).toEqual([['t0'], ['t1']]);
  });

  it('gives a command whose port 0 was allocated per run a key of its own', () => {
    const declaration: TargetApp = { url: 'http://127.0.0.1:0', command: { executable: 'pnpm', args: ['dev', '--port', '{port}'] } };
    const [first] = declaredCommands(assignPorts(configOf(declaration), { t0: 4321 }).targets, new Map());
    const [again] = declaredCommands(assignPorts(configOf(declaration), { t0: 4321 }).targets, new Map());
    const [second] = declaredCommands(assignPorts(configOf(declaration), { t0: 4322 }).targets, new Map());
    expect(first!.key).toBe(again!.key);
    expect(first!.key).not.toBe(second!.key);
  });
});
