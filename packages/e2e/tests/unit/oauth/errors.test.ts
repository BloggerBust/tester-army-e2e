import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerProviderKey } from '@e2e-dev/core/lib/run/secrecy';
import { describeResponse, readJsonBody } from '../../../src/oauth/errors.ts';

const reply = (body: string) => new Response(body, { status: 400, statusText: 'Bad Request' });

describe('describeResponse', () => {
  it('names the failure from whichever field the body carries, preferring the description', async () => {
    expect(await describeResponse(reply(JSON.stringify({ error: 'invalid_grant', error_description: 'expired' })))).toBe('400: expired');
    expect(await describeResponse(reply(JSON.stringify({ error: { message: 'Bad credentials' }, message: 'other' })))).toBe('400: Bad credentials');
    expect(await describeResponse(reply(JSON.stringify({ error: 'invalid_grant', message: 'try again' })))).toBe('400: try again');
    expect(await describeResponse(reply(JSON.stringify({ error: 'invalid_grant' })))).toBe('400: invalid_grant');
  });

  it('quotes a body of any other shape instead of throwing', async () => {
    for (const body of ['null', '[1]', '"down"', '{"error":{"code":5},"error_description":7}', '<html>']) {
      expect(await describeResponse(reply(body)), body).toBe(`400: ${body}`);
    }
    expect(await describeResponse(reply(''))).toBe('400 Bad Request');
  });
});

describe('readJsonBody', () => {
  const schema = z.object({ id: z.string() });

  it('returns the checked body, and fails the flow on one that is not JSON or not the shape', async () => {
    expect(await readJsonBody(new Response('{"id":"a","extra":1}'), schema, 'the Acme answer')).toEqual({ id: 'a' });
    await expect(readJsonBody(new Response('<html>'), schema, 'the Acme answer')).rejects.toMatchObject({ code: 'FLOW_FAILED', message: 'the Acme answer is not JSON' });
    await expect(readJsonBody(new Response('null'), schema, 'the Acme answer')).rejects.toMatchObject({ code: 'FLOW_FAILED', message: 'the Acme answer is malformed' });
    await expect(readJsonBody(new Response('{}'), schema, 'the Acme answer', 'is missing id')).rejects.toMatchObject({ code: 'FLOW_FAILED', message: 'the Acme answer is missing id' });
  });
});

describe('describeResponse and a token the vendor quotes back', () => {
  const token = 'oauth-access-token-5f2c9a71d3e84b60';
  // The token starts 10 characters before the 200-character cut, so a cut made first would leave its head.
  const padding = 'x'.repeat(190);

  it('redacts the token before cutting a body that is not JSON', async () => {
    registerProviderKey('vendor.access-token', token);
    const described = await describeResponse(reply(`${padding}${token} trailing`));
    expect(described).toBe(`400: ${padding}<secret:ve`);
    expect(described).not.toContain('oauth-acce');
  });

  it('redacts the token before cutting a JSON body that names no failure', async () => {
    registerProviderKey('vendor.access-token', token);
    const body = JSON.stringify({ note: `${'y'.repeat(180)}${token}` });
    const described = await describeResponse(reply(body));
    expect(described).toBe(`400: ${body.replace(token, '<secret:vendor.access-token>').slice(0, 200)}`);
    expect(described).not.toContain('oauth-acce');
  });

  it('redacts the token in the failure a JSON body names', async () => {
    registerProviderKey('vendor.access-token', token);
    expect(await describeResponse(reply(JSON.stringify({ error: { message: `invalid token ${token}` } })))).toBe('400: invalid token <secret:vendor.access-token>');
    expect(await describeResponse(reply(JSON.stringify({ error: 'invalid_grant', error_description: `revoked ${token}` })))).toBe('400: revoked <secret:vendor.access-token>');
  });
});
