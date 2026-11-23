import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { repeatedLines, split } from './docs-prose.ts';

/** The texts `repeatedLines` finds in a page made of `lines`. */
function repeats(...lines: string[]): string[] {
  return repeatedLines(lines.join('\n')).map(({ text }) => text);
}

describe('split', () => {
  it('blanks each line of a code block, so prose keeps its line numbers and its paragraphs', () => {
    const page = 'Run the command below.\n```bash\nnpx e2e run\n```\nRun the command below.';
    const { prose, code } = split(page);
    assert.deepEqual(prose, ['Run the command below.', '', '', '', 'Run the command below.']);
    assert.deepEqual(code, ['```bash\nnpx e2e run\n```']);
  });

  it('closes a fence only on the same character, at least as long, with nothing after it', () => {
    // A shorter fence, a fence with an info string, and the other fence character stay inside the block.
    const { prose, code } = split('````md\n```\n````ts\n~~~~\n````\nAfter the block.');
    assert.deepEqual(code, ['````md\n```\n````ts\n~~~~\n````']);
    assert.deepEqual(prose, ['', '', '', '', '', 'After the block.']);
  });

  it('reads a fence indented inside an MDX component as a fence', () => {
    const { prose, code } = split('<CodeGroup>\n    ```bash\n    npx e2e run\n    ```\n</CodeGroup>');
    assert.deepEqual(code, ['    ```bash\n    npx e2e run\n    ```']);
    assert.deepEqual(prose, ['<CodeGroup>', '', '', '', '</CodeGroup>']);
  });
});

describe('repeatedLines', () => {
  it('finds the tail a suggestion anchored one line too high leaves, at its line in the file', () => {
    // docs/hi/mobile.mdx on #2035: the old line 293 survived below its replacement.
    const page = [
      '---',
      'title: मोबाइल',
      '---',
      '',
      '```ts',
      "await device.clearKeychain();",
      '```',
      '',
      'keychain को नहीं छूता। `clearKeychain()` कॉल करने पर, पहले से सेव किया हुआ सेशन',
      'टोकन अगले लॉन्च पर नहीं रहता। `clearKeychain()` सिर्फ़ iOS पर है।',
      'लॉन्च पर नहीं रहता। `clearKeychain()` सिर्फ़ iOS पर है।',
    ].join('\n');
    assert.deepEqual(repeatedLines(page), [
      { line: 11, text: 'लॉन्च पर नहीं रहता। `clearKeychain()` सिर्फ़ iOS पर है।' },
    ]);
  });

  it('passes the same paragraph once the suggestion is applied to the right lines', () => {
    // The fixed paragraph on #2035.
    const lines = [
      '`device.clearKeychain()` सिम्युलेटर का keychain रीसेट करता है। `app.clearState()`',
      'keychain को नहीं छूता। `clearKeychain()` कॉल करने पर, पहले से सेव किया हुआ सेशन',
      'टोकन अगले लॉन्च पर नहीं रहता। `clearKeychain()` सिर्फ़ iOS पर है।',
    ];
    assert.deepEqual(repeats(...lines), []);
  });

  it('finds a line equal to the one above it, once per extra copy', () => {
    const line = 'The job exits with code 1.';
    assert.deepEqual(repeats(line, line, line), [line, line]);
  });

  it('flags only a line that ends the one above it, not one that starts it or sits inside it', () => {
    assert.deepEqual(repeats('Stop the run here, then check the config.', 'Stop the run here,'), []);
    assert.deepEqual(repeats('First stop the run here, then check it.', 'stop the run here'), []);
  });

  it('compares each line with the one directly above it in the same paragraph only', () => {
    assert.deepEqual(repeats('The job exits with code 1.', '', 'The job exits with code 1.'), []);
    assert.deepEqual(
      repeats('The job exits with code 1.', 'Then the next step runs.', 'The job exits with code 1.'),
      [],
    );
    assert.deepEqual(
      repeats('The job exits with code 1.', '```', 'x', '```', 'The job exits with code 1.'),
      [],
    );
  });

  it('reads no code inside a tilde fence', () => {
    assert.deepEqual(repeats('~~~yaml', 'retries: 2 # per test', 'retries: 2 # per test', '~~~'), []);
  });

  it('ends the frontmatter at its first closing line, even with a --- line in a later code block', () => {
    // docs/ja/migrate/maestro.mdx has a `---` line inside a code block.
    const page = ['---', 'title: Maestro', '---', '', '```yaml', 'appId: x', '---', '```'];
    page.push('The job exits 1.', 'job exits 1.');
    assert.deepEqual(repeatedLines(page.join('\n')), [{ line: 10, text: 'job exits 1.' }]);
  });

  it('leaves a line that is only a tag, as nested components close', () => {
    assert.deepEqual(repeats('</Accordion>', '</Accordion>'), []);
    assert.deepEqual(repeats('<AccordionGroup>', '<AccordionGroup>'), []);
    assert.deepEqual(repeats('<Note>Check the app first.</Note>', '<Note>Check the app first.</Note>'), [
      '<Note>Check the app first.</Note>',
    ]);
  });

  it('reads frontmatter only at the top of the page', () => {
    const page = ['The job exits with code 1.', 'job exits with code 1.', '', '---', 'x', '---', 'Body.'];
    assert.deepEqual(repeatedLines(page.join('\n')), [{ line: 2, text: 'job exits with code 1.' }]);
  });

  it('reads no frontmatter, where one key can end the key above it', () => {
    const page = ['---', 'og:description: Run the suite in CI.', 'description: Run the suite in CI.'];
    page.push('---', 'Body.');
    assert.deepEqual(repeats(...page), []);
  });

  it('ignores indentation, so a list item continuation counts too', () => {
    assert.deepEqual(repeats('- Check the config, then stop the run here.  ', '  stop the run here.'), [
      'stop the run here.',
    ]);
  });

  it('flags a repeat of 12 characters and leaves a shorter one, which can end a line by chance', () => {
    assert.deepEqual(repeats('First this. Stop it now.', 'Stop it now.'), ['Stop it now.']);
    assert.deepEqual(repeats('First this. Stop it no.', 'Stop it no.'), []);
  });
});
