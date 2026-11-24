import { describe, expect, it } from 'vitest';
import { EngineError, resolveExpression, type SemanticNode, type ViewportIntersection } from '@e2e-dev/core/lib/engine/index';
import { expect as expectFixture } from '../../src/expect/index.ts';
import { createScreenFixture } from '../helpers/screen-fixture.ts';
import { screenOver } from '../helpers/screen-over.ts';
import { snapshot } from '../helpers/snapshot.ts';
import { useFakeTime } from '../helpers/fake-time.ts';

useFakeTime();

const target: SemanticNode = { ref: { id: 'target', revision: '' }, role: 'generic', testId: 'target' };

/** A screen whose `target` node is present while `present()` says so, measured by `measure`. */
function screenMeasuring(
  measure: () => ViewportIntersection | Promise<ViewportIntersection>,
  present: () => boolean = () => true,
  node: SemanticNode = target,
) {
  return screenOver({
    locate: (expression) => resolveExpression(expression, present() ? [node] : []),
    observe: () => snapshot([node]),
    viewportIntersection: measure,
    timeoutMs: 300,
  }).screen;
}

const failure = (promise: Promise<void>) => promise.then(() => expect.unreachable('expected a failure'), (error: unknown) => error);

describe('toBeInViewport', () => {
  it('passes on any area inside by default and compares the share with ratio', async () => {
    const locator = screenMeasuring(() => ({ intersects: true, ratio: 0.1 })).getByTestId('target');

    await expectFixture(locator).toBeInViewport();
    await expectFixture(locator).toBeInViewport({ ratio: 0 });
    await expectFixture(locator).toBeInViewport({ ratio: 0.1 });
    expect(await failure(expectFixture(locator).toBeInViewport({ ratio: 0.11, timeout: 50 }))).toMatchObject({
      code: 'ASSERTION_FAILED',
      message: expect.stringMatching(/expected: at least 0\.11 of its box inside the viewport\nobserved: 0\.1 of its box/),
    });
  });

  it('reads no match and a box outside as outside the viewport', async () => {
    const absent = screenMeasuring(() => ({ intersects: true, ratio: 1 }), () => false).getByTestId('target');
    await expectFixture(absent).not.toBeInViewport({ timeout: 50 });
    expect(await failure(expectFixture(absent).toBeInViewport({ timeout: 50 }))).toMatchObject({
      message: expect.stringContaining('observed: no node'),
    });

    const outside = screenMeasuring(() => ({ intersects: false, ratio: 0 })).getByTestId('target');
    await expectFixture(outside).not.toBeInViewport({ timeout: 50 });
  });

  it('polls until the node enters the viewport', async () => {
    let inside = false;
    setTimeout(() => (inside = true), 25);
    const locator = screenMeasuring(() => (inside ? { intersects: true, ratio: 1 } : { intersects: false, ratio: 0 }));

    await expectFixture(locator.getByTestId('target')).toBeInViewport({ timeout: 200 });
  });

  it('refuses ratio on an engine that measures only the visible part of a box, even under .not', async () => {
    const visiblePart = screenMeasuring(() => ({ intersects: true })).getByTestId('target');
    await expectFixture(visiblePart).toBeInViewport();
    // 0 asks for any part, which needs no share.
    await expectFixture(visiblePart).toBeInViewport({ ratio: 0 });
    for (const negated of [false, true]) {
      const expectation = negated ? expectFixture(visiblePart).not : expectFixture(visiblePart);
      expect(await failure(expectation.toBeInViewport({ ratio: 0.5 }))).toMatchObject({
        code: 'UNSUPPORTED_CAPABILITY',
        message: expect.stringContaining('drop ratio'),
      });
    }
    // Nothing of the node is on screen, so no share is needed to answer.
    await expectFixture(screenMeasuring(() => ({ intersects: false })).getByTestId('target')).not.toBeInViewport({ ratio: 0.5 });
  });

  it('fails at once when the engine cannot measure the node, even under .not', async () => {
    const unmeasurable = screenMeasuring(() => {
      throw new EngineError('UNSUPPORTED_CAPABILITY', 'node target has no bounds on the screen', { retryable: false });
    }).getByTestId('target');
    expect(await failure(expectFixture(unmeasurable).not.toBeInViewport())).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });

    // Refused before the resolve: a missing match must not let `.not` pass on an engine that cannot measure.
    for (const nodes of [[target], []]) {
      const noCapability = createScreenFixture(nodes).getByTestId('target');
      expect(await failure(expectFixture(noCapability).not.toBeInViewport())).toMatchObject({
        code: 'UNSUPPORTED_CAPABILITY',
        message: expect.stringContaining('does not implement viewportIntersection'),
      });
    }
  });

  it('samples a node that went stale before it was measured again instead of reading it as gone', async () => {
    let measures = 0;
    const flaky = screenMeasuring(() => {
      measures += 1;
      if (measures === 1) throw new EngineError('NODE_STALE', 'navigation changed', { retryable: true });
      return { intersects: true, ratio: 1 };
    }).getByTestId('target');
    await expectFixture(flaky).toBeInViewport({ timeout: 200 });
    expect(measures).toBe(2);

    const stale = screenMeasuring(() => {
      throw new EngineError('NODE_STALE', 'navigation changed', { retryable: true });
    }).getByTestId('target');
    expect(await failure(expectFixture(stale).not.toBeInViewport({ timeout: 50 }))).toMatchObject({
      code: 'ASSERTION_FAILED',
      message: expect.stringContaining('observed: a node that went stale before it was measured'),
    });
  });

  it('measures a secure field without reading or printing its value', async () => {
    const secure: SemanticNode = { ...target, role: 'textbox', value: 'hunter2', states: { secure: true } };
    const locator = screenMeasuring(() => ({ intersects: false, ratio: 0 }), () => true, secure).getByTestId('target');

    await expectFixture(locator).not.toBeInViewport();
    const error = await failure(expectFixture(locator).toBeInViewport({ timeout: 50 }));
    expect(error).toMatchObject({ code: 'ASSERTION_FAILED' });
    expect(String((error as Error).message)).not.toContain('hunter2');
  });

  it('fails on an engine answer outside the contract or one that contradicts itself', async () => {
    for (const answer of [
      { intersects: true, ratio: 2 },
      { intersects: false, ratio: -0.1 },
      { intersects: 'yes' } as unknown as ViewportIntersection,
      { intersects: false, ratio: 1 },
      { intersects: true, ratio: 0 },
    ]) {
      const locator = screenMeasuring(() => answer).getByTestId('target');
      expect(await failure(expectFixture(locator).not.toBeInViewport({ ratio: 1 }))).toMatchObject({ code: 'ENGINE_FAILURE' });
    }
  });

  it('prints a share that falls short of ratio in full when rounding would show it as met', async () => {
    const locator = screenMeasuring(() => ({ intersects: true, ratio: 0.99975 })).getByTestId('target');
    expect(await failure(expectFixture(locator).toBeInViewport({ ratio: 1, timeout: 50 }))).toMatchObject({
      message: expect.stringContaining('observed: 0.99975 of its box inside the viewport'),
    });
  });

  it('rejects an invalid ratio and unknown options before reading', () => {
    const locator = expectFixture(createScreenFixture([target]).getByTestId('target'));

    for (const ratio of [-0.1, 1.1, Number.NaN, '0.5']) {
      expect(() => locator.toBeInViewport({ ratio: ratio as number })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    }
    expect(() => locator.toBeInViewport({ threshold: 0.5 } as never)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });
});
