import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DOCS_LANGUAGES } from './docs-languages.ts';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * Runs a copy of the check against a docs tree of one English page and its
 * Hindi translation, `hindi`, so the script reads the fixture, not the repo.
 */
function check(hindi: string): { status: number | null; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), 'e2e-docs-translations-'));
  roots.push(root);
  cpSync(SCRIPTS, join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'docs.json'), JSON.stringify({ navigation: { tabs: [] } }));
  writeFileSync(join(root, 'docs', 'mobile.mdx'), '---\ntitle: Mobile\n---\n\nIt is iOS only.\n');
  for (const language of DOCS_LANGUAGES) {
    mkdirSync(join(root, 'docs', language));
    writeFileSync(join(root, 'docs', language, 'navigation.json'), '{}');
  }
  writeFileSync(join(root, 'docs', 'hi', 'mobile.mdx'), hindi);
  const script = join(root, 'scripts', 'check-docs-translations.ts');
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  return { status: run.status, stderr: run.stderr };
}

describe('check-docs-translations', () => {
  it('fails on a translated line that repeats the end of the line above it, naming its line', () => {
    const { status, stderr } = check(
      '---\ntitle: मोबाइल\n---\n\n' +
        'टोकन अगले लॉन्च पर नहीं रहता। यह सिर्फ़ iOS पर है।\n' +
        'लॉन्च पर नहीं रहता। यह सिर्फ़ iOS पर है।\n',
    );
    assert.equal(status, 1);
    assert.match(stderr, /docs\/hi\/mobile\.mdx:6: "लॉन्च पर नहीं रहता। यह सिर्फ़ iOS पर है।" repeats/);
    assert.match(stderr, /no line repeats the end of the line above it/);
  });

  it('passes the same page without the repeat', () => {
    const { status, stderr } = check('---\ntitle: मोबाइल\n---\n\nयह सिर्फ़ iOS पर है।\n');
    assert.equal(status, 0, stderr);
  });
});
