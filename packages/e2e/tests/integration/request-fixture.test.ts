/** The `request` fixture: HTTP calls from a test and its hooks, each one a step on the running budget. */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineEngine } from '@e2e-dev/core/lib/engine/index';
import type { E2EConfig } from '../../src/index.ts';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { freePort } from '../helpers/free-port.ts';
import { hookLog, LOG_MODULE } from '../helpers/hook-log.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject, resultByTitle, runExisting, type FixtureProject, type RunProjectOptions } from '../helpers/run-project.ts';

/** A small JSON API on loopback; `closed` lists the hanging calls whose connection the client dropped. */
interface Api {
  readonly url: string;
  readonly closed: string[];
  /** Every path the server was asked for. */
  readonly paths: string[];
  close(): Promise<void>;
}

async function startApi(): Promise<Api> {
  const closed: string[] = [];
  const paths: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    paths.push(url.pathname);
    if (url.pathname === '/api/orders' && request.method === 'POST') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ received: JSON.parse(body) as unknown, contentType: request.headers['content-type'], query: url.search, auth: request.headers.authorization ?? null }));
      });
      return;
    }
    if (url.pathname === '/api/cookies') {
      response.setHeader('set-cookie', ['a=1', 'b=2']);
      response.end('ok');
      return;
    }
    if (url.pathname === '/api/echo') {
      request.resume();
      response.setHeader('x-method', request.method ?? '');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        method: request.method,
        cookie: request.headers.cookie ?? null,
        connection: request.headers.connection ?? null,
        contentType: request.headers['content-type'] ?? null,
        range: request.headers.range ?? null,
        acceptEncoding: request.headers['accept-encoding'] ?? null,
      }));
      return;
    }
    if (url.pathname === '/api/redirect') {
      response.writeHead(302, { location: '/api/ok', 'set-cookie': ['sid=1; Path=/', 'csrf=2; Path=/'] });
      response.end('redirecting');
      return;
    }
    if (url.pathname === '/api/slow') {
      setTimeout(() => response.end('slow'), 600);
      return;
    }
    if (url.pathname === '/api/stall-body') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('partial');
      response.on('close', () => closed.push(url.searchParams.get('who') ?? 'stall'));
      return;
    }
    if (url.pathname === '/api/hang') {
      response.on('close', () => closed.push(url.searchParams.get('who') ?? 'hang'));
      return;
    }
    if (url.pathname === '/api/ok') {
      response.end('ok');
      return;
    }
    if (url.pathname === '/api/proto') {
      response.setHeader('__proto__', 'kept');
      response.end('ok');
      return;
    }
    response.writeHead(404, 'Not Found');
    // The method that arrived, so a test can tell it from the one its label names.
    response.end(request.method);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    closed,
    paths,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

let api: Api;
const projects: FixtureProject[] = [];
beforeAll(async () => { api = await startApi(); });
afterEach(() => { for (const project of projects.splice(0)) project.cleanup(); });
afterAll(async () => { await api.close(); });

/** Runs a fixture project and registers it for removal after the test. */
async function runFixture(
  files: Readonly<Record<string, string>>,
  options: RunProjectOptions,
) {
  const project = createProject(files);
  projects.push(project);
  return { outcome: await runExisting(project, options), project };
}

/** Every step `report.json` holds whose api is a `request` call, in order. */
function reportedRequestSteps(report: unknown): { label: string }[] {
  const found: { label: string }[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== 'object') return;
    const step = node as { api?: unknown; label?: unknown };
    if (typeof step.api === 'string' && step.api.startsWith('request.') && typeof step.label === 'string') found.push({ label: step.label });
    Object.values(node).forEach(walk);
  };
  walk(report);
  return found;
}

/** One fake-engine target whose app is the API. */
function onApi(extra: Partial<E2EConfig> = {}): Partial<E2EConfig> {
  return { targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine().engine, app: { url: api.url } }], ...extra };
}

describe('request fixture', () => {
  it('sends calls against the app URL, records each as a step, and returns a WebResponse', async () => {
    const file = `import { test, expect } from 'e2e';

test('creates an order', async ({ request }) => {
  const created = await request.post('/api/orders?ref=r1', { json: { sku: 'A1' }, headers: { authorization: 'Bearer t' } });
  expect(created.status).toBe(201);
  expect(created.url).toBe('${api.url}/api/orders?ref=r1');
  expect(await created.json()).toEqual({ received: { sku: 'A1' }, contentType: 'application/json', query: '?ref=r1', auth: 'Bearer t' });
  const cookies = await request.get('/api/cookies');
  expect(cookies.headers['set-cookie']).toBe('a=1\\nb=2');
  expect(Object.hasOwn((await request.get('/api/proto')).headers, '__proto__')).toBe(true);
  expect(await cookies.text()).toBe('ok');
  const bytes = await cookies.body();
  expect(Buffer.isBuffer(bytes) && bytes.toString('utf8')).toBe('ok');
  const missing = await request.fetch('/api/missing', { method: 'delete' });
  expect(missing.status).toBe(404);
  expect(await missing.text()).toBe('DELETE');
  for (const [method, call] of [['PUT', request.put], ['PATCH', request.patch], ['DELETE', request.delete]] as const) {
    expect((await (await call('/api/echo')).json()).method).toBe(method);
  }
  expect((await request.head('/api/echo')).headers['x-method']).toBe('HEAD');
  const echoed = await (await request.post('/api/echo', { body: '{"raw":1}', headers: { cookie: 'session=abc', connection: 'Close' } })).json();
  expect(echoed).toMatchObject({ method: 'POST', cookie: 'session=abc', connection: 'close', contentType: 'text/plain;charset=UTF-8' });
  const encodingOnly = await (await request.get('/api/echo', { headers: { 'accept-encoding': 'gzip' } })).json();
  expect(encodingOnly).toMatchObject({ acceptEncoding: 'gzip', range: null });
  const rangeOnly = await (await request.get('/api/echo', { headers: { range: 'bytes=0-9' } })).json();
  expect(rangeOnly).toMatchObject({ range: 'bytes=0-9' });
});
`;
    const { outcome } = await runFixture({ 'tests/api.e2e.ts': file }, { config: onApi() });
    assertValidReport(outcome.report);
    const created = resultByTitle(outcome, 'creates an order');
    expect(created.status, JSON.stringify(created.attempts[0]?.error)).toBe('passed');
    expect(created.attempts[0]!.steps.map(({ kind, api: name, label, status }) => ({ kind, api: name, label, status }))).toEqual([
      { kind: 'resource', api: 'request.post', label: 'POST /api/orders', status: 'passed' },
      { kind: 'resource', api: 'request.get', label: 'GET /api/cookies', status: 'passed' },
      { kind: 'resource', api: 'request.get', label: 'GET /api/proto', status: 'passed' },
      { kind: 'resource', api: 'request.fetch', label: 'DELETE /api/missing', status: 'passed' },
      { kind: 'resource', api: 'request.put', label: 'PUT /api/echo', status: 'passed' },
      { kind: 'resource', api: 'request.patch', label: 'PATCH /api/echo', status: 'passed' },
      { kind: 'resource', api: 'request.delete', label: 'DELETE /api/echo', status: 'passed' },
      { kind: 'resource', api: 'request.head', label: 'HEAD /api/echo', status: 'passed' },
      { kind: 'resource', api: 'request.post', label: 'POST /api/echo', status: 'passed' },
      { kind: 'resource', api: 'request.get', label: 'GET /api/echo', status: 'passed' },
      { kind: 'resource', api: 'request.get', label: 'GET /api/echo', status: 'passed' },
    ]);
  });

  it('follows redirects by default, returns the 3xx response on redirect manual, and fails on redirect error', async () => {
    const file = `import { test, expect } from 'e2e';

test('redirect modes', async ({ request }) => {
  const followed = await request.get('/api/redirect');
  expect(followed.status).toBe(200);
  expect(followed.url).toBe('${api.url}/api/ok');
  expect(followed.headers['set-cookie']).toBeUndefined();
  expect(await followed.text()).toBe('ok');

  const explicitFollow = await request.get('/api/redirect', { redirect: 'follow' });
  expect(explicitFollow.status).toBe(200);
  expect(explicitFollow.url).toBe('${api.url}/api/ok');

  const manual = await request.get('/api/redirect', { redirect: 'manual' });
  expect(manual.status).toBe(302);
  expect(manual.url).toBe('${api.url}/api/redirect');
  expect(manual.headers['location']).toBe('/api/ok');
  expect(manual.headers['set-cookie']).toBe('sid=1; Path=/\\ncsrf=2; Path=/');
  expect(await manual.text()).toBe('redirecting');

  const okWithError = await request.get('/api/ok', { redirect: 'error' });
  expect(okWithError.status).toBe(200);
});

test('redirect error on redirect', async ({ request }) => {
  await request.get('/api/redirect', { redirect: 'error' });
});
`;
    const { outcome } = await runFixture({ 'tests/redirect.e2e.ts': file }, { config: onApi() });
    const modes = resultByTitle(outcome, 'redirect modes');
    expect(modes.status, JSON.stringify(modes.attempts[0]?.error)).toBe('passed');
    expect(resultByTitle(outcome, 'redirect error on redirect').attempts[0]!.error).toMatchObject({
      code: 'ACTION_FAILED',
      message: expect.stringContaining('GET /api/redirect failed: fetch failed:'),
    });
  });

  it('aborts a call at the action timeout, and an afterEach call runs on its own budget after the body timed out', async () => {
    const file = `import { test } from 'e2e';
import { log } from './log.ts';

test('hangs past the action timeout', async ({ request }) => {
  await request.get('/api/hang?who=action');
});

test('stalls in the body past its own timeout', async ({ request }) => {
  await request.get('/api/stall-body?who=body', { timeout: 300 });
});

test('hangs past its own timeout', async ({ request }) => {
  await request.get('/api/hang?who=own', { timeout: 300 });
});

test.describe('cleanup', () => {
  test.afterEach(async ({ request }) => {
    log('afterEach:' + (await request.get('/api/ok')).status);
  });
  test('hangs past the test timeout', { timeout: 400 }, async ({ request }) => {
    await request.get('/api/hang?who=deadline');
  });
});
`;
    const log = hookLog('request-fixture');
    const { outcome } = await runFixture({ 'tests/log.ts': LOG_MODULE, 'tests/hang.e2e.ts': file }, { config: onApi({ actionTimeout: 1_500 }) });
    const action = resultByTitle(outcome, 'hangs past the action timeout').attempts[0]!;
    expect(action.error?.code).toBe('ACTION_FAILED');
    expect(action.error?.message).toContain('GET /api/hang exceeded its timeout of 1500ms');
    expect(resultByTitle(outcome, 'hangs past its own timeout').attempts[0]!.error?.message).toContain('GET /api/hang exceeded its timeout of 300ms');
    // The headers arrived; the call still waits for the whole body under the same timeout.
    expect(resultByTitle(outcome, 'stalls in the body past its own timeout').attempts[0]!.error?.message).toContain('GET /api/stall-body exceeded its timeout of 300ms');
    const deadline = resultByTitle(outcome, 'hangs past the test timeout').attempts[0]!;
    expect(deadline.error?.code).toBe('TEST_TIMEOUT');
    expect(log.lines()).toEqual(['afterEach:200']);
    // The connection is dropped, not left open past the test.
    await vi.waitFor(() => expect(api.closed.toSorted()).toEqual(['action', 'body', 'deadline', 'own']));
  });

  it('takes an absolute URL on a target with no engine, and names the missing app URL for a path', async () => {
    const file = `import { test, expect } from 'e2e';

test('absolute', async ({ request }) => {
  expect((await request.get('${api.url}/api/ok?x=1')).status).toBe(200);
});

test('a malformed absolute URL', async ({ request }) => {
  await request.get('http://[invalid');
});

test('relative', async ({ request }) => {
  await request.get('/api/ok?token=query-placeholder-6021');
});

test('another scheme', async ({ request }) => {
  await request.get('file:///etc/hosts');
});

test('a blank page', async ({ request }) => {
  await request.get('about:blank');
});
`;
    const { outcome } = await runFixture({ 'tests/api.e2e.ts': file }, { config: { targets: [{ name: 'api', platform: 'api' }] } });
    const absolute = resultByTitle(outcome, 'absolute');
    expect(absolute.status, JSON.stringify(absolute.attempts[0]?.error)).toBe('passed');
    expect(absolute.attempts[0]!.steps.map((step) => step.label)).toEqual([`GET ${api.url}/api/ok`]);
    expect(resultByTitle(outcome, 'relative').attempts[0]!.error).toMatchObject({
      code: 'APP_URL_REQUIRED',
      message: expect.stringContaining('request: a path needs an app URL'),
    });
    expect(JSON.stringify(outcome.report)).not.toContain('query-placeholder-6021');
    expect(resultByTitle(outcome, 'another scheme').attempts[0]!.error?.code).toBe('POLICY_DENIED');
    expect(resultByTitle(outcome, 'a malformed absolute URL').attempts[0]!.error).toMatchObject({ code: 'POLICY_DENIED', message: 'request: malformed URL' });
    expect(resultByTitle(outcome, 'a blank page').attempts[0]!.error).toMatchObject({ code: 'POLICY_DENIED', message: 'request: a URL must be a path or an absolute http(s) URL' });
  });

  it('refuses a malformed call before sending it, and names a network failure', async () => {
    const closed = await freePort();
    // Not a configured secret: nothing redacts it, so only the fixture keeps it out.
    const PLACEHOLDER = 'unregistered-placeholder-5150';
    const file = `import { secrets, test } from 'e2e';

test('a GET with a body', async ({ request }) => {
  await request.get('/api/ok', { json: { a: 1 } });
});

test('json and body', async ({ request }) => {
  await request.post('/api/orders', { json: { a: 1 }, body: 'x' });
});

test('a method with a space', async ({ request }) => {
  await request.fetch('/api/ok', { method: 'GET X' });
});

test('a refused connection', async ({ request }) => {
  await request.get('http://127.0.0.1:${closed}/api/ok');
});

test('a refused connection on localhost', async ({ request }) => {
  await request.get('http://localhost:${closed}/api/ok');
});

test('an option request does not take', async ({ request }) => {
  await request.post('/api/refused-options', { data: { sku: 'A1' }, params: { id: '17' } } as never);
});

test('a content-length header', async ({ request }) => {
  await request.post('/api/refused-options', { headers: { 'content-length': '1' } });
});

test('a host header', async ({ request }) => {
  await request.get('/api/refused-options', { headers: { Host: 'tenant-a.example.test' } });
});

test('a header fetch sets itself', async ({ request }) => {
  await request.get('/api/refused-options', { headers: { 'Sec-Fetch-Mode': 'navigate' } });
});

test('a header fetch refuses', async ({ request }) => {
  await request.post('/api/refused-options', { body: 'a', headers: { 'Transfer-Encoding': 'chunked' } });
});

test('a connection header fetch would replace', async ({ request }) => {
  await request.get('/api/refused-options', { headers: { connection: 'upgrade' } });
});

test('an expect header', async ({ request }) => {
  await request.post('/api/refused-options', { body: 'a', headers: { Expect: '100-continue' } });
});

test('accept-encoding with range', async ({ request }) => {
  await request.get('/api/refused-options', { headers: { Range: 'bytes=0-9', 'Accept-Encoding': 'gzip, identity;q=0' } });
});

test('an invalid redirect mode', async ({ request }) => {
  await request.get('/api/refused-options', { redirect: 'none' as never });
});

test('a body that is not JSON', async ({ request }) => {
  await (await request.get('/api/ok')).json();
});

test('a header value that is not a string', async ({ request }) => {
  await request.get('/api/refused-options', { headers: { 'x-count': 3 as never } });
});

test('headers as a Headers object', async ({ request }) => {
  await request.get('/api/refused-options', { headers: new Headers({ authorization: 'Bearer t' }) as never });
});

test('a refusal is a rejected promise and a failed step', async ({ request }) => {
  const settled = await request.get('/api/ok', { body: 'raw' }).then(() => 'sent', (error: { code?: string }) => error.code);
  if (settled !== 'INVALID_ARGUMENT') throw new Error('settled as ' + settled);
});

test('headers that are not an object', async ({ request }) => {
  await request.get('/api/ok', { headers: 42 as never });
});

test('a header value with a line break', async ({ request }) => {
  await request.get('/api/ok', { headers: { authorization: 'Bearer ${PLACEHOLDER}\\nx: y' } });
});

test('credentials in the URL', async ({ request }) => {
  await request.get('http://user:${PLACEHOLDER}@127.0.0.1:${closed}/api/ok?token=${PLACEHOLDER}');
});

test('TRACE', async ({ request }) => {
  await request.fetch('/api/ok', { method: 'trace' });
});

test('a negative timeout', async ({ request }) => {
  await request.get('/api/ok', { timeout: -1 });
});

test('a timeout no timer holds', async ({ request }) => {
  await request.get('/api/ok', { timeout: 2 ** 31 });
});

test('a control character in a header', async ({ request }) => {
  await request.get('/api/ok', { headers: { 'x-trace': 'a\\u0001b' } });
});

test('a secret in json', async ({ request }) => {
  await request.post('/api/secret-sink', { json: { token: secrets.get('TOKEN') } });
});

test('a bigint in json', async ({ request }) => {
  await request.post('/api/orders', { json: { n: 1n } });
});
`;
    const { outcome } = await runFixture({ 'tests/api.e2e.ts': file }, { config: onApi({ secrets: { TOKEN: 'request-sink-secret' } }) });
    const errorOf = (title: string) => resultByTitle(outcome, title).attempts[0]!.error;
    expect(errorOf('a GET with a body')).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'request: a GET request takes no body' });
    expect(errorOf('json and body')).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'request: pass json or body, not both' });
    expect(errorOf('a method with a space')?.code).toBe('INVALID_ARGUMENT');
    expect(errorOf('a refused connection')).toMatchObject({
      code: 'ACTION_FAILED',
      message: expect.stringContaining(`GET http://127.0.0.1:${closed}/api/ok failed: fetch failed: connect ECONNREFUSED`),
    });
    // localhost resolves to two addresses, so Node's refusal is an AggregateError with an empty message.
    expect(errorOf('a refused connection on localhost')?.message).toMatch(new RegExp(`^GET http://localhost:${closed}/api/ok failed: fetch failed: .*ECONNREFUSED`));
    expect(errorOf('an option request does not take')).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'request.post options has no keys "data", "params"; it takes headers, json, body, timeout, redirect' });
    expect(errorOf('headers as a Headers object')?.code).toBe('INVALID_ARGUMENT');
    // V8's own message would quote the start of the body ("ok"), which can be part of a secret.
    expect(errorOf('a body that is not JSON')?.message).toBe('the response body of GET /api/ok is not valid JSON');
    expect(errorOf('a header value that is not a string')).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'request: header "x-count" must be a string' });
    expect(errorOf('a content-length header')).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'request: header "content-length" is set by fetch itself; leave it out' });
    expect(errorOf('a host header')).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'request: header "Host" is set by fetch itself; leave it out' });
    expect(errorOf('a header fetch sets itself')).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'request: header "Sec-Fetch-Mode" is set by fetch itself; leave it out' });
    expect(errorOf('a header fetch refuses')).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'request: header "Transfer-Encoding" cannot be sent with fetch; leave it out' });
    expect(errorOf('an expect header')).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'request: header "Expect" cannot be sent with fetch; leave it out' });
    expect(errorOf('accept-encoding with range')).toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'request: header "Accept-Encoding" cannot be combined with "range"; fetch appends identity to accept-encoding on range requests',
    });
    expect(errorOf('an invalid redirect mode')).toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'request: redirect must be "follow", "manual", or "error"',
    });
    expect(errorOf('a connection header fetch would replace')).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'request: header "connection" must be close or keep-alive; fetch manages the connection' });
    expect(api.paths).not.toContain('/api/refused-options');
    const refusal = resultByTitle(outcome, 'a refusal is a rejected promise and a failed step').attempts[0]!;
    expect(refusal.error, JSON.stringify(refusal.error)).toBeUndefined();
    expect(refusal.steps.map(({ api: name, label, status, error }) => ({ api: name, label, status, code: error?.code }))).toEqual([
      { api: 'request.get', label: 'GET /api/ok', status: 'failed', code: 'INVALID_ARGUMENT' },
    ]);
    expect(errorOf('a negative timeout')?.message).toBe('request.get timeout must be a finite number of milliseconds, 0 or more; got -1');
    // A refused URL leaves the label empty, so nothing it holds is shown.
    expect(resultByTitle(outcome, 'credentials in the URL').attempts[0]!.steps.map((step) => step.label)).toEqual(['']);
    expect(errorOf('headers that are not an object')?.code).toBe('INVALID_ARGUMENT');
    expect(errorOf('a header value with a line break')).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'request: header "authorization" has an invalid name or value' });
    expect(errorOf('credentials in the URL')).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'request: a URL must not contain credentials; send them in headers' });
    expect(errorOf('TRACE')?.code).toBe('INVALID_ARGUMENT');
    expect(errorOf('a bigint in json')).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'request: json must be JSON-safe, found bigint' });
    expect(errorOf('a timeout no timer holds')).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'request.get timeout must be at most 2147483647 milliseconds, got 2147483648' });
    expect(errorOf('a control character in a header')).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'request: header "x-trace" has an invalid name or value' });
    expect(errorOf('a secret in json')).toMatchObject({ code: 'POLICY_DENIED', message: 'request: json must not contain a Secret' });
    expect(api.paths).not.toContain('/api/secret-sink');
    expect(JSON.stringify(outcome.report)).not.toContain(PLACEHOLDER);
  });

  it('is a test fixture, which a beforeAll hook cannot name', async () => {
    const file = `import { test } from 'e2e';

test.beforeAll(async ({ request }) => {
  await request.get('/api/ok');
});

test('runs', async () => {});
`;
    const { outcome } = await runFixture({ 'tests/api.e2e.ts': file }, { config: onApi() });
    expect(outcome.report.run.errors).toEqual([expect.objectContaining({ code: 'COLLECTION_ERROR', message: expect.stringContaining('beforeAll hook names "request", a test fixture on target "fake"') })]);
  });

  it('keeps a configured secret out of the step label and the failure', async () => {
    const secret = 'tok-secret-4711';
    const file = `import { test, expect } from 'e2e';

test('leaks nothing', async ({ request }) => {
  expect((await request.get('/api/missing/${secret}')).status).toBe(200);
});
`;
    const { outcome } = await runFixture({ 'tests/api.e2e.ts': file }, { config: onApi({ secrets: { TOKEN: secret } }) });
    const attempt = resultByTitle(outcome, 'leaks nothing').attempts[0]!;
    expect(attempt.error?.code).toBe('ASSERTION_FAILED');
    expect(attempt.steps.map((step) => step.label)).toEqual(['GET /api/missing/<secret:TOKEN>']);
    expect(JSON.stringify(outcome.report)).not.toContain(secret);
  });

  it('waits past the action timeout with timeout 0', async () => {
    const file = `import { test, expect } from 'e2e';

test('no own timeout', async ({ request }) => {
  expect(await (await request.get('/api/slow', { timeout: 0 })).text()).toBe('slow');
});

test('the action timeout', async ({ request }) => {
  await request.get('/api/slow');
});
`;
    const { outcome } = await runFixture({ 'tests/api.e2e.ts': file }, { config: onApi({ actionTimeout: 300 }) });
    const unbounded = resultByTitle(outcome, 'no own timeout');
    expect(unbounded.status, JSON.stringify(unbounded.attempts[0]?.error)).toBe('passed');
    expect(resultByTitle(outcome, 'the action timeout').attempts[0]!.error?.message).toContain('GET /api/slow exceeded its timeout of 300ms');
  });

  it('runs a worker-scoped project fixture named request in place of the built-in', async () => {
    const support = `import { test as base } from 'e2e';
export const test = base.extend<{}, { request: { hello(): string } }>({
  request: [async ({}, use) => { await use({ hello: () => 'mine' }); }, { scope: 'worker' }],
});
`;
    const file = `import { test } from './support.ts';
test('uses it', async ({ request }) => { if (request.hello() !== 'mine') throw new Error('got the built-in'); });
`;
    const { outcome } = await runFixture({ 'tests/support.ts': support, 'tests/api.e2e.ts': file }, { config: onApi() });
    expect(outcome.report.run.errors).toEqual([]);
    expect(resultByTitle(outcome, 'uses it').status).toBe('passed');
  });

  it('cuts a step label to what the report admits, and sends the whole URL', async () => {
    const file = `import { test, expect } from 'e2e';

test('a long path', async ({ request }) => {
  const response = await request.get('/files/' + 'x'.repeat(9000));
  expect(response.status).toBe(404);
});
`;
    const { outcome } = await runFixture({ 'tests/api.e2e.ts': file }, { config: onApi() });
    // The recorder keeps the whole label; report.json cuts it to what its schema admits.
    expect(resultByTitle(outcome, 'a long path').attempts[0]!.steps[0]!.label).toHaveLength('GET /files/'.length + 9000);
    const [reported] = reportedRequestSteps(outcome.report);
    expect(reported!.label).toHaveLength(8192);
    expect(reported!.label.endsWith('…')).toBe(true);
    assertValidReport(outcome.report);
    expect(api.paths).toContain('/files/' + 'x'.repeat(9000));
  });

  it('redacts a secret before it cuts a long label, so no part of it is shown', async () => {
    const secret = 'zq-straddle-secret-7731';
    // "GET /files/" is 11 characters, so the secret starts at 8181 and runs past the cut at 8191.
    const file = `import { test } from 'e2e';

test('a secret across the cut', async ({ request }) => {
  await request.get('/files/' + 'x'.repeat(8170) + '${secret}');
});
`;
    const { outcome } = await runFixture({ 'tests/api.e2e.ts': file }, { config: onApi({ secrets: { TOKEN: secret } }) });
    const [step] = resultByTitle(outcome, 'a secret across the cut').attempts[0]!.steps;
    expect(step!.label.endsWith('<secret:TOKEN>')).toBe(true);
    const [reported] = reportedRequestSteps(outcome.report);
    expect(reported!.label).toHaveLength(8192);
    expect(reported!.label).not.toContain(secret.slice(0, 10));
    expect(JSON.stringify(outcome.report)).not.toContain(secret.slice(0, 10));
  });

  it('is a name no engine may contribute', () => {
    expect(() => defineEngine({ name: 'shadow', version: '1.0.0', spiVersion: 1, platform: 'shadow', fixtures: { request: () => ({}) } })).toThrow(
      'fixture name "request" shadows a universal fixture',
    );
  });
});
