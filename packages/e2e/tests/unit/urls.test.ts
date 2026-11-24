import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkObservedLocation,
  isFileBase,
  isImplicitTestHost,
  isLoopbackHost,
  normalizeBaseUrl,
  portOf,
  printableUrl,
  requestsFreePort,
  resolveNavigationUrl,
  sameSite,
  siteOf,
  urlMatches,
} from '@e2e-dev/core/lib/internal/urls';

describe('base URL ports', () => {
  it('tells a free-port request from a fixed or default port', () => {
    const requested = normalizeBaseUrl('http://[::1]:0/app/');
    expect(requestsFreePort(requested)).toBe(true);
    expect(portOf(requested)).toBe(0);
    expect(requestsFreePort(normalizeBaseUrl('https://app.test'))).toBe(false);
    expect(portOf(normalizeBaseUrl('https://app.test'))).toBe(443);
    expect(portOf(normalizeBaseUrl('http://localhost:3000'))).toBe(3000);
  });
});

describe('normalizeBaseUrl', () => {
  it('normalizes default ports, dot segments, and IDNA hosts', () => {
    expect(normalizeBaseUrl('https://EXAMPLE.test:443/a/../b').href).toBe('https://example.test/b');
    expect(normalizeBaseUrl('http://localhost:3000').origin).toBe('http://localhost:3000');
  });

  it('rejects userinfo, query, and fragment', () => {
    expect(() => normalizeBaseUrl('https://user:pw@example.test')).toThrow(/userinfo/);
    expect(() => normalizeBaseUrl('https://example.test/?q=1')).toThrow(/query/);
    expect(() => normalizeBaseUrl('https://example.test/#frag')).toThrow(/fragment/);
  });

  it('rejects plain HTTP for non-loopback hosts', () => {
    expect(() => normalizeBaseUrl('http://example.test')).toThrow(/loopback/);
    expect(normalizeBaseUrl('http://127.0.0.1:8080').origin).toBe('http://127.0.0.1:8080');
  });

  it('accepts port 0 on a literal loopback address only, where the run picks a free port', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:0').origin).toBe('http://127.0.0.1:0');
    expect(normalizeBaseUrl('http://[::1]:0/app').href).toBe('http://[::1]:0/app');
    // A name may resolve to another address than the one the command binds.
    expect(() => normalizeBaseUrl('localhost:0/app')).toThrow(/port 0 .* 127\.0\.0\.1 or \[::1\]/);
    expect(() => normalizeBaseUrl('https://app.test:0')).toThrow(/port 0 .* 127\.0\.0\.1 or \[::1\]/);
  });

  it('treats root-terminated localhost names as loopback, not remote HTTP', () => {
    for (const host of ['localhost.', 'app.localhost.']) {
      expect(isLoopbackHost(host)).toBe(true);
      expect(normalizeBaseUrl(`${host}:3000`).origin).toBe(`http://${host}:3000`);
      expect(normalizeBaseUrl(`http://${host}:3000`).origin).toBe(`http://${host}:3000`);
    }
    expect(isImplicitTestHost('api.test.')).toBe(true);
    expect(isLoopbackHost('example.org.')).toBe(false);
    expect(() => normalizeBaseUrl('http://example.org.:3000')).toThrow(/loopback/);
    expect(isLoopbackHost('localhost..')).toBe(false);
  });

  it('rejects every scheme but http(s) and file', () => {
    expect(() => normalizeBaseUrl('javascript:alert(1)')).toThrow(/must be http\(s\)/);
    // A single-slash scheme is still a scheme, never a host named after it.
    expect(() => normalizeBaseUrl('ftp:/server/path')).toThrow(/must be http\(s\)/);
    expect(() => normalizeBaseUrl('data:text/html,hi')).toThrow(/must be http\(s\)/);
  });

  it('infers https for a schemeless host and http for a schemeless loopback host', () => {
    expect(normalizeBaseUrl('tester.army').href).toBe('https://tester.army/');
    expect(normalizeBaseUrl('www.tester.army/app').href).toBe('https://www.tester.army/app');
    expect(normalizeBaseUrl('localhost:3000').origin).toBe('http://localhost:3000');
    expect(normalizeBaseUrl('localhost:3000/app').href).toBe('http://localhost:3000/app');
    expect(normalizeBaseUrl('app.test:8443').origin).toBe('https://app.test:8443');
    expect(normalizeBaseUrl('http:/localhost:3000').origin).toBe('http://localhost:3000');
    expect(normalizeBaseUrl('127.0.0.1:8080/base/').basePath).toBe('/base/');
    expect(normalizeBaseUrl('[::1]:4000').origin).toBe('http://[::1]:4000');
    expect(() => normalizeBaseUrl('tester.army?q=1')).toThrow(/query/);
  });
});

describe('printableUrl', () => {
  it('drops userinfo, query, and fragment, any of which may carry a credential', () => {
    expect(printableUrl('http://user:pw@127.0.0.1:4310/health?token=abc#x')).toBe('http://127.0.0.1:4310/health');
    expect(printableUrl('http://127.0.0.1:4310')).toBe('http://127.0.0.1:4310/');
  });
});

describe('isLoopbackHost', () => {
  it('accepts localhost, *.localhost, 127.0.0.0/8, and ::1', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('app.localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('example.test')).toBe(false);
  });
});

describe('a file app URL', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'e2e-file-app-'));
  mkdirSync(path.join(directory, 'site', 'pages'), { recursive: true });
  for (const file of ['site/index.html', 'site/pages/about.html', 'site/..notes.html', 'secret.html']) writeFileSync(path.join(directory, file), '<p>hi</p>');
  // Links inside the directory: one to the directory above it, one to a file there.
  symlinkSync(directory, path.join(directory, 'site', 'up'));
  symlinkSync(path.join(directory, 'secret.html'), path.join(directory, 'site', 'linked.html'));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  const at = (file: string): string => pathToFileURL(path.join(directory, file)).href;
  const base = normalizeBaseUrl(at('site/index.html'));
  const denied = (message: RegExp) => expect.objectContaining({ code: 'POLICY_DENIED', message: expect.stringMatching(message) });

  it('names one file on this machine, with an origin no other URL has and no port', () => {
    expect(base.href).toBe(at('site/index.html'));
    expect(isFileBase(base)).toBe(true);
    expect(base.origin).toBe('file://');
    expect(portOf(base)).toBeUndefined();
    // A single slash is the same file, `localhost` is this machine, and the file may not exist yet.
    expect(normalizeBaseUrl(at('site/index.html').replace('file:///', 'file:/')).href).toBe(base.href);
    expect(normalizeBaseUrl(at('site/index.html').replace('file://', 'file://localhost')).href).toBe(base.href);
    expect(normalizeBaseUrl(at('site/not-built-yet.html')).href).toBe(at('site/not-built-yet.html'));
    expect(isFileBase(normalizeBaseUrl('http://localhost:3000'))).toBe(false);
  });

  it('refuses a host, a directory, a query, and a fragment', () => {
    const refused = (message: RegExp) => expect.objectContaining({ code: 'INVALID_APP_URL', message: expect.stringMatching(message) });
    expect(() => normalizeBaseUrl('file://fileserver/share/index.html')).toThrow(refused(/with no host/));
    expect(() => normalizeBaseUrl(`${at('site')}/`)).toThrow(refused(/not a directory/));
    // A directory named without its slash is still one: the browser would list it.
    expect(() => normalizeBaseUrl(at('site'))).toThrow(refused(/not a directory/));
    expect(() => normalizeBaseUrl(`${at('site/index.html')}?tab=1`)).toThrow(refused(/query/));
    expect(() => normalizeBaseUrl(`${at('site/index.html')}#top`)).toThrow(refused(/fragment/));
  });

  it('navigates to a file in the app file\'s directory or below it', () => {
    expect(resolveNavigationUrl('pages/about.html', base).url).toBe(at('site/pages/about.html'));
    expect(resolveNavigationUrl('index.html?tab=2#top', base).url).toBe(`${at('site/index.html')}?tab=2#top`);
    expect(resolveNavigationUrl(at('site/pages/about.html'), base).url).toBe(at('site/pages/about.html'));
    expect(resolveNavigationUrl('https://other.test/x', base).url).toBe('https://other.test/x');
    // Two leading dots are a name, not a way up; a file that does not exist yet is still in the directory.
    expect(resolveNavigationUrl('..notes.html', base).url).toBe(at('site/..notes.html'));
    expect(resolveNavigationUrl('pages/new.html', base).url).toBe(at('site/pages/new.html'));
  });

  it.each([
    ['up/secret.html'],
    ['linked.html'],
    ['up/site/../secret.html'],
    ['pages/a%00b.html'],
    [`pages/${'a'.repeat(300)}.html`],
    ['../secret.html'],
    ['pages/../../secret.html'],
    ['/etc/passwd'],
    ['file:///etc/passwd'],
    ['..%2fsecret.html'],
    ['pages/..%2F..%2Fsecret.html'],
    ['%2e%2e/secret.html'],
    ['file://fileserver/share/index.html'],
  ])('denies %j: outside the directory', (input) => {
    expect(() => resolveNavigationUrl(input, base)).toThrow(denied(/stays in the directory of the app's file/));
  });

  it.each([['pages'], ['pages/'], ['.'], ['./'], ['up/site/pages']])('denies the directory %j: its listing links to its parent', (input) => {
    expect(() => resolveNavigationUrl(input, base)).toThrow(denied(/not a directory|stays in the directory/));
  });

  it('keeps every wrapper scheme denied', () => {
    expect(() => resolveNavigationUrl(`view-source:${at('site/index.html')}`, base)).toThrow(denied(/forbidden URL scheme: view-source:/));
    expect(() => resolveNavigationUrl('data:text/html,x', base)).toThrow(denied(/forbidden URL scheme: data:/));
  });

  it('refuses what a model would observe once the page has left the directory', () => {
    expect(() => checkObservedLocation(at('site/pages/about.html'), base)).not.toThrow();
    expect(() => checkObservedLocation(`${at('site/index.html')}#top`, base)).not.toThrow();
    expect(() => checkObservedLocation('https://other.test/x', base)).not.toThrow();
    expect(() => checkObservedLocation('about:blank', base)).not.toThrow();
    expect(() => checkObservedLocation(undefined, base)).not.toThrow();
    expect(() => checkObservedLocation(at('secret.html'), base)).toThrow(denied(/a file app stays in the directory of the app's file/));
    expect(() => checkObservedLocation(at('site/linked.html'), base)).toThrow(denied(/stays in the directory/));
    expect(() => checkObservedLocation(`${at('site/pages')}/`, base)).toThrow(denied(/opens a file, not a directory/));
    expect(() => checkObservedLocation('file:///', base)).toThrow(denied(/stays in the directory/));
    // Another app's observations are not this rule's: an http app cannot be led to a file at all.
    expect(() => checkObservedLocation(at('secret.html'), normalizeBaseUrl('http://localhost:3000'))).not.toThrow();
    expect(() => checkObservedLocation(at('secret.html'), undefined)).not.toThrow();
  });

  it('stays denied on a target whose app is not a file', () => {
    const web = normalizeBaseUrl('http://localhost:3000/app/');
    expect(() => resolveNavigationUrl(at('site/index.html'), web)).toThrow(denied(/forbidden URL scheme: file:/));
    expect(() => resolveNavigationUrl(at('site/index.html'), undefined)).toThrow(denied(/forbidden URL scheme: file:/));
  });
});

describe('resolveNavigationUrl', () => {
  const base = normalizeBaseUrl('http://localhost:3000/app/');

  it('resolves relative paths against the base', () => {
    expect(resolveNavigationUrl('/billing', base).url).toBe('http://localhost:3000/billing');
    expect(resolveNavigationUrl('settings', base).url).toBe('http://localhost:3000/app/settings');
  });

  it('admits any http(s) origin: a click reaches one just as well', () => {
    expect(resolveNavigationUrl('https://other.test/x', base).url).toBe('https://other.test/x');
  });

  it('always denies file:, data:, and javascript:', () => {
    expect(() => resolveNavigationUrl('file:///etc/passwd', base)).toThrow(/scheme/);
    expect(() => resolveNavigationUrl('data:text/html,x', base)).toThrow(/scheme/);
    expect(() => resolveNavigationUrl('javascript:alert(1)', base)).toThrow(/scheme/);
  });

  it.each([
    ['view-source:file:///etc/passwd', 'view-source:'],
    ['view-source:http://localhost:3000/', 'view-source:'],
    ['VIEW-SOURCE:file:///etc/passwd', 'view-source:'],
    ['  view-source:file:///etc/passwd', 'view-source:'],
    ['\tview-source:file:///etc/passwd\n', 'view-source:'],
    ['view-\tsource:file:///etc/passwd', 'view-source:'],
    ['FiLe:///etc/passwd', 'file:'],
    [' file:///etc/passwd', 'file:'],
    ['blob:http://localhost:3000/0b7c4c1e', 'blob:'],
    ['filesystem:http://localhost:3000/temporary/x', 'filesystem:'],
    ['chrome://version', 'chrome:'],
    ['chrome-extension://abcdefghijklmnop/page.html', 'chrome-extension:'],
    ['devtools://devtools/bundled/inspector.html', 'devtools:'],
    ['about:blank#x', 'about:'],
    ['about:blank?x', 'about:'],
    ['about:srcdoc', 'about:'],
    ['about:version', 'about:'],
    ['ftp://example.test/x', 'ftp:'],
    ['ws://localhost:3000/socket', 'ws:'],
    ['myapp://orders/42', 'myapp:'],
  ])('denies %j: only http(s) is navigable', (input, scheme) => {
    expect(() => resolveNavigationUrl(input, base)).toThrowError(
      expect.objectContaining({ code: 'POLICY_DENIED', message: `forbidden URL scheme: ${scheme}` }),
    );
    expect(() => resolveNavigationUrl(input, undefined)).toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));
  });

  it('reads a percent-encoded scheme as a path, not a scheme', () => {
    expect(resolveNavigationUrl('view-source%3Afile:///etc/passwd', base).url).toBe('http://localhost:3000/app/view-source%3Afile:///etc/passwd');
    expect(resolveNavigationUrl('%66ile:///etc/passwd', base).url).toBe('http://localhost:3000/app/%66ile:///etc/passwd');
  });

  it('admits exactly about:blank, which loads nothing', () => {
    expect(resolveNavigationUrl('about:blank', base).url).toBe('about:blank');
    expect(resolveNavigationUrl(' ABOUT:blank ', undefined).url).toBe('about:blank');
  });

  it('admits http(s) in any case and with surrounding whitespace', () => {
    expect(resolveNavigationUrl('HTTPS://Other.test/x', base).url).toBe('https://other.test/x');
    expect(resolveNavigationUrl('  http://localhost:3000/a ', base).url).toBe('http://localhost:3000/a');
    expect(resolveNavigationUrl('//other.test/x', base).url).toBe('http://other.test/x');
  });
});

describe('siteOf and sameSite', () => {
  it('reads the registrable domain without a public suffix list', () => {
    expect(siteOf('tester.army')).toBe('tester.army');
    expect(siteOf('auth.tester.army')).toBe('tester.army');
    expect(siteOf('a.b.app.example.com')).toBe('example.com');
    expect(siteOf('shop.example.co.uk')).toBe('example.co.uk');
    expect(siteOf('example.co.uk')).toBe('example.co.uk');
    expect(siteOf('Example.COM')).toBe('example.com');
  });

  it('treats loopback names and IP literals as sites of their own', () => {
    expect(siteOf('localhost')).toBe('localhost');
    expect(siteOf('app.localhost')).toBe('app.localhost');
    expect(siteOf('127.0.0.1')).toBe('127.0.0.1');
    expect(siteOf('[::1]')).toBe('[::1]');
  });

  it('compares a URL to a site by host alone, and puts an unparseable URL off every site', () => {
    expect(sameSite('https://auth.tester.army/login', 'tester.army')).toBe(true);
    expect(sameSite('http://127.0.0.1:4000/api', '127.0.0.1')).toBe(true);
    expect(sameSite('http://localhost:4000/', '127.0.0.1')).toBe(false);
    expect(sameSite('https://evil.test/', 'tester.army')).toBe(false);
    expect(sameSite('null', 'tester.army')).toBe(false);
  });
});

describe('urlMatches', () => {
  const base = normalizeBaseUrl('http://localhost:3000');

  it('resolves relative expected strings against the base URL', () => {
    expect(urlMatches('http://localhost:3000/billing', '/billing', base.href)).toBe(true);
  });

  it('compares exactly after WHATWG serialization', () => {
    expect(urlMatches('http://localhost:3000/a', 'http://localhost:3000/a/../a', base.href)).toBe(true);
    expect(urlMatches('http://localhost:3000/a?x=1', '/a', base.href)).toBe(false);
  });

  it('tests regexps against the complete serialized URL', () => {
    expect(urlMatches('http://localhost:3000/beta/board', /beta/, base.href)).toBe(true);
    expect(urlMatches('http://localhost:3000/alpha', /beta/, base.href)).toBe(false);
  });

  it('ignoreCase folds a string comparison and sets or clears the i flag of a regexp', () => {
    expect(urlMatches('http://localhost:3000/Billing', '/billing', base.href)).toBe(false);
    expect(urlMatches('http://localhost:3000/Billing', '/billing', base.href, true)).toBe(true);
    expect(urlMatches('http://localhost:3000/Billing', '/billing', base.href, false)).toBe(false);
    expect(urlMatches('http://localhost:3000/Billing', /billing$/, base.href, true)).toBe(true);
    expect(urlMatches('http://localhost:3000/Billing', /billing$/i, base.href)).toBe(true);
    expect(urlMatches('http://localhost:3000/Billing', /billing$/i, base.href, false)).toBe(false);
  });

  it('rejects a predicate instead of matching every URL', () => {
    const predicate = ((url: URL) => url.pathname === '/other') as unknown as RegExp;
    expect(() => urlMatches('http://localhost:3000/items', predicate, base.href)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });
});
