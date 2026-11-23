/**
 * `e2e run --device`: the device the one selected target whose engine
 * selects devices runs on. It reaches that target's `prepare`, and a run
 * with no such target, or several, fails before any engine is prepared.
 */

import { describe, expect, it } from 'vitest';
import type { EngineHandle, EnginePrepareInfo } from '@e2e-dev/core/lib/engine/index';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject } from '../helpers/run-project.ts';

const SUITE = { 'tests/a.e2e.ts': "import { test } from 'e2e';\n\ntest('runs', async () => {});\n" };

/** A fake engine whose `prepare` records what it was asked, selecting devices when `selects` is set. */
function engine(selects: boolean): { engine: EngineHandle; prepares: EnginePrepareInfo[] } {
  const fake = createFakeEngine();
  const prepares: EnginePrepareInfo[] = [];
  return {
    prepares,
    engine: {
      ...fake.engine,
      ...(selects ? { selectsDevice: true } : {}),
      async prepare(info) {
        prepares.push(info);
      },
    },
  };
}

const target = (name: string, handle: EngineHandle) => ({ name, platform: name, engine: handle, app: FAKE_APP });
const runErrors = (outcome: Awaited<ReturnType<typeof runProject>>['outcome']) =>
  outcome.report.run.errors.map(({ code, message }) => ({ code, message }));

describe('e2e run --device', () => {
  it('hands the device to the prepare of the one target whose engine selects devices, and to no other', async () => {
    const ios = engine(true);
    const web = engine(false);
    const { outcome, project } = await runProject(SUITE, {
      config: { targets: [target('ios', ios.engine), target('web', web.engine)] },
      runOptions: { device: 'iPhone 17 Pro' },
    });
    try {
      assertValidReport(outcome.report);
      expect(runErrors(outcome)).toEqual([]);
      expect(resultByTitle(outcome, 'runs').status).toBe('passed');
      expect(ios.prepares.map((info) => info.device)).toEqual(['iPhone 17 Pro']);
      expect(web.prepares.map((info) => 'device' in info)).toEqual([false]);
    } finally {
      project.cleanup();
    }
  });

  it('picks among several device targets with --target, and asks for one without it', async () => {
    const ios = engine(true);
    const android = engine(true);
    const config = { targets: [target('ios', ios.engine), target('android', android.engine)] };
    const picked = await runProject(SUITE, { config, runOptions: { device: 'Pixel_9', targetIds: ['android'] } });
    try {
      expect(runErrors(picked.outcome)).toEqual([]);
      expect(android.prepares.map((info) => info.device)).toEqual(['Pixel_9']);
      expect(ios.prepares).toEqual([]);
    } finally {
      picked.project.cleanup();
    }

    const ios2 = engine(true);
    const android2 = engine(true);
    const both = await runProject(SUITE, {
      config: { targets: [target('ios', ios2.engine), target('android', android2.engine)] },
      runOptions: { device: 'Pixel_9' },
    });
    try {
      expect(runErrors(both.outcome)).toEqual([
        { code: 'TARGET_REQUIRED', message: '--device names one device, and "ios", "android" each select one; pick a target with --target' },
      ]);
      // Refused before anything is prepared or run.
      expect([...ios2.prepares, ...android2.prepares]).toEqual([]);
      expect(both.outcome.report.run.results).toEqual([]);
    } finally {
      both.project.cleanup();
    }
  });

  it('refuses a run whose selected targets have no device to select, and names only those targets in the header', async () => {
    const android = engine(true);
    const web = engine(false);
    const started: (readonly string[])[] = [];
    const { outcome, project } = await runProject(SUITE, {
      config: { targets: [target('android', android.engine), target('web', web.engine)] },
      runOptions: {
        device: 'Pixel_9',
        targetIds: ['web'],
        onEvent: (event) => {
          if (event.type === 'run-started') started.push(event.targets);
        },
      },
    });
    try {
      expect(runErrors(outcome)).toEqual([
        {
          code: 'UNSUPPORTED_CAPABILITY',
          message: '--device names the device a target runs on, and no selected target\'s engine selects one ("web"); use it with a mobile() target on local devices, not a device provider\'s',
        },
      ]);
      expect(started).toEqual([['web']]);
      expect([...android.prepares, ...web.prepares]).toEqual([]);
      expect(outcome.report.run.results).toEqual([]);
    } finally {
      project.cleanup();
    }
  });
});
