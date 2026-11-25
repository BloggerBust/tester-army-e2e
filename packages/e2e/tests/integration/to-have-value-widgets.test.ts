/** `toHaveValue` on nodes that are not form controls, through the public locator and matcher on a real page. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, resultByTitle, runExisting, type FixtureProject } from '../helpers/run-project.ts';

const SUITE = `import { test, expect } from 'e2e';

const PAGE = [
  '<div role="slider" aria-label="Volume" aria-valuenow="50" tabindex="0"></div>',
  '<div role="slider" aria-label="Power" aria-valuenow="1" aria-valuetext="On" tabindex="0"></div>',
  '<div role="spinbutton" aria-label="Seats" aria-valuenow="3" tabindex="0"></div>',
  '<div role="progressbar" aria-label="Upload" aria-valuenow="40"></div>',
  '<progress aria-label="Download" value="7" max="10"></progress>',
  '<meter aria-label="Disk" value="0.5"></meter>',
  '<input type="range" aria-label="Native" value="30" aria-valuetext="Thirty">',
  '<div role="progressbar" aria-label="Pending"></div>',
  '<div role="progressbar" aria-label="Blank" aria-valuenow=""></div>',
  '<progress aria-label="Over" value="20" max="10"></progress>',
  '<progress aria-label="Invalid" value="abc"></progress>',
  '<meter aria-label="Full" value="150" max="100"></meter>',
  '<div role="slider" aria-label="Blank text" aria-valuenow="50" aria-valuetext="" tabindex="0"></div>',
  '<div role="spinbutton" aria-label="Month" contenteditable aria-valuenow="5" aria-valuetext="May">05</div>',
  '<div role="scrollbar" aria-label="Page" aria-controls="x" aria-valuenow="20" tabindex="0"></div>',
  '<progress aria-label="Indeterminate"></progress>',
  '<div role="progressbar" aria-label="Stray" value="20"></div>',
  '<progress aria-label="Mixed" value="7" max="10" aria-valuenow="70"></progress>',
  '<div role="slider" aria-label="Spaced text" aria-valuenow="50" aria-valuetext="  " tabindex="0"></div>',
  '<div role="slider" aria-label="Padded" aria-valuetext=" On " tabindex="0"></div>',
  '<meter aria-label="Unset"></meter>',
  '<progress aria-label="Zero max" value="5" max="0"></progress>',
  '<progress aria-label="Negative" value="-3" max="10"></progress>',
  '<meter aria-label="Below min" value="1" min="5" max="10"></meter>',
  '<meter aria-label="Inverted" value="8" min="5" max="2"></meter>',
  '<div role="slider" aria-label="Bare" tabindex="0"></div>',
  '<svg><progress role="progressbar" aria-label="Foreign" data-testid="foreign" value="5"></progress></svg>',
].join('');

test('reads range widgets', async ({ app, browser, screen }) => {
  await app.open('/');
  await browser.evaluate((html) => { document.body.innerHTML = html; }, PAGE);
  await expect(screen.getByRole('slider', { name: 'Volume' })).toHaveValue('50');
  await expect(screen.getByRole('slider', { name: 'Power' })).toHaveValue('On');
  await expect(screen.getByRole('spinbutton', { name: 'Seats' })).toHaveValue('3');
  await expect(screen.getByRole('progressbar', { name: 'Upload' })).toHaveValue('40');
  await expect(screen.getByRole('progressbar', { name: 'Download' })).toHaveValue('7');
  await expect(screen.getByRole('meter', { name: 'Disk' })).toHaveValue('0.5');
  await expect(screen.getByRole('slider', { name: 'Native' })).toHaveValue('30');
  await expect(screen.getByRole('progressbar', { name: 'Over' })).toHaveValue('10');
  await expect(screen.getByRole('progressbar', { name: 'Invalid' })).toHaveValue('0');
  await expect(screen.getByRole('meter', { name: 'Full' })).toHaveValue('100');
  await expect(screen.getByRole('slider', { name: 'Blank text' })).toHaveValue('50');
  await expect(screen.getByRole('spinbutton', { name: 'Month' })).toHaveValue('05');
  await expect(screen.getByRole('scrollbar', { name: 'Page' })).toHaveValue('20');
  await expect(screen.getByRole('progressbar', { name: 'Mixed' })).toHaveValue('70');
  await expect(screen.getByRole('progressbar', { name: 'Zero max' })).toHaveValue('1');
  await expect(screen.getByRole('progressbar', { name: 'Negative' })).toHaveValue('0');
  await expect(screen.getByRole('meter', { name: 'Below min' })).toHaveValue('5');
  await expect(screen.getByRole('meter', { name: 'Inverted' })).toHaveValue('5');
  await expect(screen.getByRole('slider', { name: 'Bare' })).toHaveValue('');
  await expect(screen.getByRole('slider', { name: 'Spaced text' })).toHaveValue('50');
  await expect(screen.getByRole('slider', { name: 'Padded' })).toHaveValue(' On ');
  await expect(screen.getByRole('slider', { name: 'Volume' })).not.toHaveValue('51');
  expect(await screen.getByRole('slider', { name: 'Power' }).inputValue()).toBe('On');
});

test('still refuses a range widget with no value', async ({ app, browser, screen }) => {
  await app.open('/');
  await browser.evaluate((html) => { document.body.innerHTML = html; }, PAGE);
  await expect(screen.getByRole('progressbar', { name: 'Pending' })).toHaveValue('', { timeout: 300 });
});

test('still refuses a range widget with a blank value', async ({ app, browser, screen }) => {
  await app.open('/');
  await browser.evaluate((html) => { document.body.innerHTML = html; }, PAGE);
  await expect(screen.getByRole('progressbar', { name: 'Blank' })).toHaveValue('', { timeout: 300 });
});

test('still refuses an indeterminate progress', async ({ app, browser, screen }) => {
  await app.open('/');
  await browser.evaluate((html) => { document.body.innerHTML = html; }, PAGE);
  await expect(screen.getByRole('progressbar', { name: 'Indeterminate' })).toHaveValue('', { timeout: 300 });
});

test('still refuses a stray value attribute on a range widget', async ({ app, browser, screen }) => {
  await app.open('/');
  await browser.evaluate((html) => { document.body.innerHTML = html; }, PAGE);
  await expect(screen.getByRole('progressbar', { name: 'Stray' })).toHaveValue('20', { timeout: 300 });
});

test('still refuses a meter with no value attribute', async ({ app, browser, screen }) => {
  await app.open('/');
  await browser.evaluate((html) => { document.body.innerHTML = html; }, PAGE);
  await expect(screen.getByRole('meter', { name: 'Unset' })).toHaveValue('0', { timeout: 300 });
});

test('still refuses a progress outside the HTML namespace', async ({ app, browser, screen }) => {
  await app.open('/');
  await browser.evaluate((html) => { document.body.innerHTML = html; }, PAGE);
  await expect(screen.getByTestId('foreign')).toHaveValue('5', { timeout: 300 });
});

test('never runs a range widget value getter while finding another field', async ({ app, browser, screen }) => {
  await app.open('/');
  await browser.evaluate(() => {
    customElements.define('upload-progress', class extends HTMLElement {
      get value(): number { throw new Error('upload-progress: not ready'); }
    });
    document.body.innerHTML = '<label>Email <input value="ada@example.test"></label><upload-progress role="progressbar" aria-label="Upload"></upload-progress>';
  });
  await expect(screen.getByLabel('Email', { exact: true })).toHaveCount(1);
  await expect(screen.getByLabel('Email', { exact: true })).toHaveValue('ada@example.test');
});

test('never runs a customized built-in value getter', async ({ app, browser, screen }) => {
  await app.open('/');
  await browser.evaluate(() => {
    customElements.define('throwing-progress', class extends HTMLProgressElement {
      override get value(): number { throw new Error('upload not ready'); }
    }, { extends: 'progress' });
    customElements.define('percent-progress', class extends HTMLProgressElement {
      override get value(): number { return 100; }
    }, { extends: 'progress' });
    document.body.innerHTML = '<input aria-label="Email" value="ada">' +
      '<progress is="throwing-progress" aria-label="Upload" value="1" max="10"></progress>' +
      '<progress is="percent-progress" aria-label="Percent" value="20" max="10"></progress>';
  });
  expect(await screen.getByLabel('Email', { exact: true }).inputValue()).toBe('ada');
  await expect(screen.getByRole('progressbar', { name: 'Upload' })).toHaveValue('1');
  await expect(screen.getByRole('progressbar', { name: 'Percent' })).toHaveValue('10');
});

test('reads a form control adopted from another frame as before', async ({ app, browser, screen }) => {
  await app.open('/');
  await browser.evaluate(() => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const moved = frame.contentDocument!.createElement('input');
    moved.type = 'number';
    moved.setAttribute('aria-label', 'Moved number');
    moved.setAttribute('aria-valuetext', 'Unset');
    document.body.append(moved);
  });
  expect(await screen.getByLabel('Moved number', { exact: true }).inputValue()).toBe('');
});

test('clamps a progress adopted from another frame', async ({ app, browser, screen }) => {
  await app.open('/');
  await browser.evaluate(() => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const moved = frame.contentDocument!.createElement('progress');
    moved.setAttribute('aria-label', 'Moved');
    moved.setAttribute('value', '20');
    moved.setAttribute('max', '10');
    document.body.append(moved);
  });
  await expect(screen.getByRole('progressbar', { name: 'Moved' })).toHaveValue('10');
});
`;

describe('toHaveValue outside form controls', () => {
  let app: FixtureApp;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/values.e2e.ts': SUITE });
  }, 60_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('reads a range widget, keeps a native input, and refuses a widget with no value', async () => {
    const outcome = await runExisting(project, { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', reporters: ['json'] as const } });
    const read = resultByTitle(outcome, 'reads range widgets');
    expect(read.attempts.at(-1)?.error, JSON.stringify(read.attempts.at(-1)?.error)).toBeUndefined();
    expect(read.status).toBe('passed');
    const refused = resultByTitle(outcome, 'still refuses a range widget with no value');
    expect(refused.status).toBe('failed');
    expect(refused.attempts.at(-1)?.error?.message).toContain('no value (not a form control)');
    for (const title of ['still refuses a range widget with a blank value', 'still refuses an indeterminate progress', 'still refuses a stray value attribute on a range widget', 'still refuses a meter with no value attribute', 'still refuses a progress outside the HTML namespace']) {
      const failed = resultByTitle(outcome, title);
      expect(failed.status, title).toBe('failed');
      expect(failed.attempts.at(-1)?.error?.message, title).toContain('no value (not a form control)');
    }
    for (const title of ['never runs a range widget value getter while finding another field', 'never runs a customized built-in value getter', 'reads a form control adopted from another frame as before']) {
      const passed = resultByTitle(outcome, title);
      expect(passed.attempts.at(-1)?.error, `${title}: ${JSON.stringify(passed.attempts.at(-1)?.error)}`).toBeUndefined();
      expect(passed.status, title).toBe('passed');
    }
    const moved = resultByTitle(outcome, 'clamps a progress adopted from another frame');
    expect(moved.attempts.at(-1)?.error, JSON.stringify(moved.attempts.at(-1)?.error)).toBeUndefined();
    expect(moved.status).toBe('passed');
  }, 120_000);
});
