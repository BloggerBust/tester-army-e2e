/**
 * `run_code`'s recorder: the code calls the real objects through it, and each
 * call is written down as the test line that repeats it. A call that returns
 * at once is a step in a chain, one that returns a promise is a line, and a
 * line that failed with nothing waiting on it is what the call fails with.
 */

import { describe, expect, it } from 'vitest';
import { KeptFailure, Recorder, type Outcome } from '../../src/session-tools/code-recorder.ts';

/** A recorder over a ledger that knows one secret, numbering names from 1. */
function recording(count = { handles: 0 }): Recorder {
  return new Recorder((text) => text.replaceAll(SECRET, '<secret:apiKey>'), () => ++count.handles);
}

const SECRET = `sk-it's-"quoted"-\\slash`;

const sources = (outcomes: readonly Outcome[]): string[] => outcomes.map((outcome) => ('error' in outcome ? `failed: ${outcome.source}` : `${outcome.read ? 'read: ' : ''}${outcome.source}`));

interface FakeLocator {
  readonly path: string;
  nth(index: number): FakeLocator;
  filter(options: { readonly has: FakeLocator }): FakeLocator;
  tap(options?: object): Promise<void>;
  fill(value: unknown): Promise<void>;
  textContent(): Promise<string>;
  screenshot(label?: string): Promise<string>;
  missing(): Promise<never>;
}

function fakeScreen(seen: unknown[] = []) {
  const locator = (path: string): FakeLocator => ({
    path,
    nth: (index) => locator(`${path}[${String(index)}]`),
    filter: ({ has }) => {
      seen.push(has);
      return locator(`${path}{${has.path}}`);
    },
    tap: () => Promise.resolve(),
    fill: (value) => {
      seen.push(value);
      return Promise.resolve();
    },
    textContent: () => Promise.resolve(`text of ${path}`),
    screenshot: () => Promise.resolve(`/artifacts/${path}.png`),
    missing: () => Promise.reject(Object.assign(new Error('locator matched no nodes'), { code: 'LOCATOR_NOT_FOUND' })),
  });
  return { getByRole: (role: string, name?: string) => locator(name === undefined ? role : `${role}:${name}`) };
}

describe('run_code recorder', () => {
  it('spells each line as a test writes it, and tells a read from an action', async () => {
    const recorder = recording();
    const screen = recorder.wrap(fakeScreen(), 'screen', true);
    const row = screen.getByRole('row').nth(2);
    await row.tap({ position: { x: 1, y: 2 }, modifiers: ['Shift'], skip: undefined });
    expect(await row.textContent()).toBe('text of row[2]');
    await screen.getByRole('textbox', "it's \\ a\nname").fill(/^a.b$/i);
    expect(sources(recorder.outcomes)).toEqual([
      "await screen.getByRole('row').nth(2).tap({ position: { x: 1, y: 2 }, modifiers: ['Shift'] });",
      "read: await screen.getByRole('row').nth(2).textContent();",
      "await screen.getByRole('textbox', 'it\\'s \\\\ a\\nname').fill(/^a.b$/i);",
    ]);
    expect(await recorder.end(new AbortController().signal)).toEqual({ unawaited: 0, lost: undefined });
  });

  it('keeps a locator screenshot as an action, though it answers with a path', async () => {
    const recorder = recording();
    const screen = recorder.wrap(fakeScreen(), 'screen', true);
    expect(await screen.getByRole('row').screenshot('row')).toBe('/artifacts/row.png');
    expect(sources(recorder.outcomes)).toEqual(["await screen.getByRole('row').screenshot('row');"]);
  });

  it('hands the real object what the code holds wrapped, and leaves the rest as it is', async () => {
    const seen: unknown[] = [];
    const recorder = recording();
    const screen = recorder.wrap(fakeScreen(seen), 'screen', true);
    const secret = Object.freeze({ name: 'apiKey', [Symbol.for('brand')]: true });
    const secrets = recorder.wrap({ get: (_name: string) => secret }, 'secrets');
    await screen.getByRole('row').filter({ has: screen.getByRole('cell', 'Ada') }).fill(secrets.get('apiKey'));
    expect((seen[0] as FakeLocator).path).toBe('cell:Ada');
    expect(seen[1]).toBe(secret);
    expect(sources(recorder.outcomes)).toEqual(["await screen.getByRole('row').filter({ has: screen.getByRole('cell', 'Ada') }).fill(secrets.get('apiKey'));"]);
  });

  it('names an object a line resolved with, and calls a function of the code as the code wrote it', async () => {
    const recorder = recording();
    const tab = { close: () => Promise.resolve() };
    const calls: unknown[] = [];
    const browser = recorder.wrap(
      Object.freeze({
        newTab: () => Promise.resolve(tab),
        evaluate: (script: () => number) => Promise.resolve(new Function(`return (${String(script)})()`)() as number),
        route: (pattern: string, handler: (value: number) => number) => {
          calls.push(handler(20));
          return Promise.resolve();
        },
        keyboard: { press: (key: string) => Promise.resolve(void calls.push(key)) },
      }),
      'browser',
    );
    const opened = await browser.newTab();
    await opened.close();
    expect(await browser.evaluate(() => 41 + 1)).toBe(42);
    await browser.route('**', (value) => value + 1);
    await browser.keyboard.press('Tab');
    expect(calls).toEqual([21, 'Tab']);
    expect(sources(recorder.outcomes)).toEqual([
      'const newTab1 = await browser.newTab();',
      'await newTab1.close();',
      // A value came back, but a function of the code ran for it, which may have changed the app.
      'await browser.evaluate(() => 41 + 1);',
      // The server called this one, so in a test it needs the variables it used; the page script above was sent as text.
      "await browser.route('**', (value) => value + 1); // the function brings none of the variables run_code declared: declare the ones it uses",
      "await browser.keyboard.press('Tab');",
    ]);
  });

  it('gives a failure to the code that waits on it, and keeps one nothing waited on', async () => {
    const caught = recording();
    const one = caught.wrap(fakeScreen(), 'screen', true);
    await expect(one.getByRole('button').missing()).rejects.toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
    expect(await caught.end(new AbortController().signal)).toEqual({ unawaited: 0, lost: undefined });
    expect(sources(caught.outcomes)).toEqual(["failed: await screen.getByRole('button').missing();"]);

    const early = recording();
    void early.wrap(fakeScreen(), 'screen', true).getByRole('button').missing();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await early.end(new AbortController().signal)).toMatchObject({ unawaited: 0, lost: { cause: { code: 'LOCATOR_NOT_FOUND' } } });

    const late = recording();
    void late.wrap(fakeScreen(), 'screen', true).getByRole('button').missing();
    expect(await late.end(new AbortController().signal)).toMatchObject({ unawaited: 1, lost: { cause: { code: 'LOCATOR_NOT_FOUND' } } });
  });

  it('parks code that was cut off at its next await, with nothing to catch and spin on', async () => {
    const recorder = recording();
    const screen = recorder.wrap(fakeScreen(), 'screen', true);
    const button = screen.getByRole('button');
    await recorder.end(AbortSignal.abort());
    let tries = 0;
    let settled = false;
    // A loop that swallows each failure and tries again: an error here would spin without ever yielding.
    void (async () => {
      for (;;) {
        tries++;
        try {
          await screen.getByRole('row').nth(1).tap();
          await button.tap();
        } catch {
          continue;
        }
        settled = true;
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect({ tries, settled }).toEqual({ tries: 1, settled: false });
    expect(recorder.outcomes).toEqual([]);
  });

  it('runs what a handler the code left behind calls after the code settled, unrecorded', async () => {
    const recorder = recording();
    const screen = recorder.wrap(fakeScreen(), 'screen', true);
    // A route handler registered in one call and fired during the next closes over this screen.
    const handler = async (): Promise<string> => screen.getByRole('status').textContent();
    await screen.getByRole('button').tap();
    await recorder.end(new AbortController().signal);
    expect(await handler()).toBe('text of status');
    expect(sources(recorder.outcomes)).toEqual(["await screen.getByRole('button').tap();"]);
  });

  it('leaves the loser of a race to the code that raced it, and a poll without a note for its own read', async () => {
    const recorder = recording();
    let fail = (_cause: Error): void => undefined;
    const screen = recorder.wrap(
      {
        fast: () => Promise.resolve(),
        slow: () => new Promise<void>((_, reject) => void (fail = reject)),
        poll: (read: () => Promise<string>) => read().then(() => undefined),
        text: () => Promise.resolve('text'),
      },
      'screen',
    );
    await Promise.race([screen.fast(), screen.slow()]);
    const ending = recorder.end(new AbortController().signal);
    fail(Object.assign(new Error('locator matched no nodes'), { code: 'LOCATOR_NOT_FOUND' }));
    expect(await ending).toEqual({ unawaited: 0, lost: undefined });

    const polled = recording();
    const page = polled.wrap({ poll: (read: () => Promise<string>) => read().then(() => undefined), text: () => Promise.resolve('text') }, 'screen');
    await page.poll(() => page.text());
    // What the function called is its own doing, written once, in its line.
    expect(sources(polled.outcomes)).toEqual(['await screen.poll(() => page.text()); // the function brings none of the variables run_code declared: declare the ones it uses']);
  });

  it("writes a credential's username by its name", async () => {
    const recorder = new Recorder((text) => text, () => 1, (text) => (text === 'ada@example.com' ? "credentials.user('admin').username" : undefined));
    await recorder.wrap(fakeScreen(), 'screen', true).getByRole('textbox').fill('ada@example.com');
    expect(sources(recorder.outcomes)).toEqual(["await screen.getByRole('textbox').fill(credentials.user('admin').username);"]);
  });

  it('counts a value as a read only from the test API, passes a class or a built-in as itself, and fails a line whose failure was kept', async () => {
    const recorder = recording();
    const seen: unknown[] = [];
    const browser = recorder.wrap({ evaluate: (script: string) => Promise.resolve(script.length), expects: (sample: unknown) => Promise.resolve(void seen.push(sample)), soft: () => Promise.resolve(new KeptFailure(Object.assign(new Error('kept'), { code: 'ASSERTION_FAILED' }))) }, 'browser');
    await browser.evaluate('document.title = "Changed"');
    await browser.expects(String);
    expect(await browser.soft()).toBeUndefined();
    expect(seen).toEqual([String]);
    expect(sources(recorder.outcomes)).toEqual(['await browser.evaluate(\'document.title = "Changed"\');', 'await browser.expects(String);', 'failed: await browser.soft();']);
    expect(await recorder.end(new AbortController().signal)).toEqual({ unawaited: 0, lost: undefined });
  });

  it('stops waiting on a line the code left when the call is cancelled', async () => {
    const recorder = recording();
    void recorder.wrap({ hang: () => new Promise<void>(() => undefined) }, 'browser').hang();
    const stop = new AbortController();
    const started = Date.now();
    setTimeout(() => stop.abort(), 20);
    expect(await recorder.end(stop.signal)).toEqual({ unawaited: 1, lost: undefined });
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('calls a member under a symbol on the real object, and keeps a function of the code one handler with its own text', async () => {
    class Feed {
      readonly #items = ['a', 'b'];
      readonly handlers: unknown[] = [];
      [Symbol.iterator](): Iterator<string> {
        return this.#items.values();
      }
      on(handler: unknown): void {
        this.handlers.push(handler);
      }
    }
    const feed = new Feed();
    const recorder = recording();
    const wrapped = recorder.wrap(feed, 'feed');
    expect([...wrapped]).toEqual(['a', 'b']);
    const handler = (value: number): number => value + 1;
    wrapped.on(handler);
    wrapped.on(handler);
    expect(feed.handlers[0]).toBe(feed.handlers[1]);
    const held = feed.handlers[0] as (value: number) => number;
    expect([held(1), String(held), held.length]).toEqual([2, '(value) => value + 1', 1]);
    expect(recorder.textOf(wrapped)).toBe('feed');
    expect(recorder.textOf(feed)).toBeUndefined();
  });

  it('writes lines in the order the code made them, and says which ran alongside another', async () => {
    const recorder = recording();
    let release = (): void => undefined;
    const browser = recorder.wrap({ waitForResponse: () => new Promise<void>((resolve) => void (release = resolve)), reload: () => Promise.resolve() }, 'browser');
    const waited = browser.waitForResponse();
    await browser.reload();
    release();
    await waited;
    expect(sources(recorder.outcomes)).toEqual([
      'await browser.waitForResponse();',
      'await browser.reload(); // ran while the line above was still running; a test needs them in one Promise.all',
    ]);
  });

  it('passes a string through the ledger before escaping it, numbers names by the session, and leaves bytes alone', async () => {
    const count = { handles: 0 };
    const tab = { close: () => Promise.resolve() };
    const bytes = Buffer.from('body');
    const make = (): { screen: ReturnType<typeof fakeScreen>; browser: { newTab(): Promise<typeof tab>; body(): Promise<Buffer> }; recorder: Recorder } => {
      const recorder = recording(count);
      return { recorder, screen: recorder.wrap(fakeScreen(), 'screen', true), browser: recorder.wrap({ newTab: () => Promise.resolve(tab), body: () => Promise.resolve(bytes) }, 'browser') };
    };
    const first = make();
    await first.screen.getByRole('textbox').fill(SECRET);
    await first.browser.newTab();
    expect(await first.browser.body()).toBe(bytes);
    const second = make();
    await second.browser.newTab();
    expect(sources(first.recorder.outcomes)).toEqual(["await screen.getByRole('textbox').fill('<secret:apiKey>');", 'const newTab1 = await browser.newTab();', 'await browser.body();']);
    expect(sources(second.recorder.outcomes)).toEqual(['const newTab2 = await browser.newTab();']);
  });

  it('keeps a list a line resolved with a real array, and records what the code does with each item', async () => {
    const recorder = recording();
    const row = (index: number) => ({ textContent: () => Promise.resolve(`row ${String(index)}`) });
    const screen = recorder.wrap({ rows: { all: () => Promise.resolve([row(0), row(1)]) } }, 'screen', true);
    const rows = await screen.rows.all();
    expect(Array.isArray(rows)).toBe(true);
    expect(await Promise.all(rows.map((item) => item.textContent()))).toEqual(['row 0', 'row 1']);
    expect(sources(recorder.outcomes)).toEqual(['const all1 = await screen.rows.all();', 'read: await all1[0].textContent();', 'read: await all1[1].textContent();']);
    // A promise the code got as a member is the code's own, not something to record calls on.
    const held = recorder.wrap({ ready: Promise.resolve('yes') }, 'held');
    expect(await held.ready).toBe('yes');
    expect(recorder.outcomes).toHaveLength(3);
  });
});
