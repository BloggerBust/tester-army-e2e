import { afterEach, describe, expect, it } from 'vitest';
import { AgentDesktopCli, AgentDesktopFailure, translate } from '../../src/cli.ts';
import { cleanupFakes, failure, fakeScenario } from '../helpers/fake.ts';

afterEach(cleanupFakes);

const call = { input: true, signal: new AbortController().signal, timeoutMs: 10_000, label: 'set-value' } as const;

describe('AgentDesktopCli', () => {
  it('returns the envelope data and hands text over on stdin, never in the arguments', async () => {
    const fake = fakeScenario({ 'set-value': [{ ok: true, data: { action: 'set-value' } }] });
    const cli = new AgentDesktopCli(fake.binary, fake.env);
    await expect(cli.run({ ...call, args: ['set-value', '@s1:e2', '--stdin'], stdin: 'hunter2' })).resolves.toEqual({ action: 'set-value' });
    const [sent] = fake.calls();
    expect(sent?.stdin).toBe('hunter2');
    expect(sent?.args.join(' ')).not.toContain('hunter2');
  });

  it('throws the failure agent-desktop reported, untranslated', async () => {
    const fake = fakeScenario({ click: [failure('STALE_REF', 'not_delivered')] });
    const cli = new AgentDesktopCli(fake.binary, fake.env);
    const error = await cli.run({ ...call, args: ['click', '@s1:e1'] }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AgentDesktopFailure);
    expect(error).toMatchObject({ code: 'STALE_REF', notDelivered: true });
  });

  it('reports an input cut off by the budget as possibly committed, and a read as timed out', async () => {
    const fake = fakeScenario({ click: [{ ok: true, data: {}, sleepMs: 5_000 }], snapshot: [{ ok: true, data: {}, sleepMs: 5_000 }] });
    const cli = new AgentDesktopCli(fake.binary, fake.env);
    await expect(cli.run({ ...call, args: ['click', '@s1:e1'], timeoutMs: 600 })).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    await expect(cli.run({ ...call, input: false, args: ['snapshot'], timeoutMs: 600 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
  });

  it('reports an input whose process printed no result as possibly committed', async () => {
    const fake = fakeScenario({ click: [{ noEnvelope: true }], snapshot: [{ noEnvelope: true }] });
    const cli = new AgentDesktopCli(fake.binary, fake.env);
    await expect(cli.run({ ...call, args: ['click', '@s1:e1'] })).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    await expect(cli.run({ ...call, input: false, args: ['snapshot'] })).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it('gives a read exactly its budget, with no floor', async () => {
    const fake = fakeScenario({ snapshot: [{ ok: true, data: {}, sleepMs: 400 }] });
    const cli = new AgentDesktopCli(fake.binary, fake.env);
    await expect(cli.run({ ...call, input: false, args: ['snapshot'], timeoutMs: 100 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
  });

  it('cancels with the signal', async () => {
    const fake = fakeScenario({ click: [{ ok: true, data: {}, sleepMs: 5_000 }] });
    const cli = new AgentDesktopCli(fake.binary, fake.env);
    const controller = new AbortController();
    const pending = cli.run({ ...call, signal: controller.signal, args: ['click', '@s1:e1'] });
    setTimeout(() => controller.abort(), 200);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('reports a missing executable as an engine failure', async () => {
    const cli = new AgentDesktopCli('/nonexistent/agent-desktop', {});
    await expect(cli.run({ ...call, args: ['status'] })).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });
});

describe('translate', () => {
  const failed = (code: string, delivery: 'not_delivered' | 'delivered_unverified' | 'unknown') =>
    new AgentDesktopFailure({ code, message: 'm', disposition: { delivery } });

  it('keeps only a refusal that sent nothing retryable or refusable', () => {
    expect(translate(failed('STALE_REF', 'not_delivered'), 'click', true)).toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(translate(failed('SNAPSHOT_NOT_FOUND', 'not_delivered'), 'click', true)).toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(translate(failed('ACTION_NOT_SUPPORTED', 'not_delivered'), 'click', true)).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(translate(failed('APP_NOT_FOUND', 'not_delivered'), 'snapshot', false)).toMatchObject({ code: 'INVALID_STATE' });
    expect(translate(failed('AMBIGUOUS_TARGET', 'not_delivered'), 'click', true)).toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(translate(failed('TIMEOUT', 'not_delivered'), 'snapshot', false)).toMatchObject({ code: 'OPERATION_TIMEOUT' });
    expect(translate(failed('TIMEOUT', 'not_delivered'), 'click', true)).toMatchObject({ code: 'NOT_ACTIONABLE' });
  });

  it('never lets an input that may have landed look retryable', () => {
    expect(translate(failed('STALE_REF', 'unknown'), 'click', true)).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
    expect(translate(failed('ACTION_FAILED', 'delivered_unverified'), 'set-value', true)).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    expect(translate(failed('TIMEOUT', 'unknown'), 'select', true)).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  });

  it('names the permission to grant', () => {
    expect(translate(failed('PERM_DENIED', 'not_delivered'), 'snapshot', false).message).toContain('Accessibility');
  });
});
