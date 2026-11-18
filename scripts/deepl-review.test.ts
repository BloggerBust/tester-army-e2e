import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  chrf,
  deepl,
  gateway,
  glossaryTsv,
  parseGlossary,
  QuotaExceeded,
  review,
  sections,
  type Translator,
  withFallback,
} from './deepl-review.ts';
import { REPO_ROOT } from './public-packages.ts';

const README = `## Style

- Polite form.

| English | Japanese |
| --- | --- |
| test, test suite | テスト, テストスイート |
| hosted browser | ホスト型ブラウザ |
| config, configuration | 設定 |
`;

/** DeepL with canned answers, keyed by the text it is given. */
function fake(answers: Record<string, string>): Translator {
  return { name: 'fake', translate: async (texts) => texts.map((text) => answers[text] ?? '') };
}

describe('chrf', () => {
  it('is 1 for the same text, ignoring case and spaces', () => {
    assert.equal(chrf('Next Page', 'next page'), 1);
    assert.equal(chrf('次 へ', '次へ'), 1);
  });

  it('scores a close paraphrase above an unrelated text', () => {
    assert.ok(chrf('ページが見つかりません', 'ページが見つかりませんでした') > 0.6);
    assert.ok(chrf('フィードバックを送信', 'ページが見つかりませんでした') < 0.2);
  });

  it('is 0 when either text is empty', () => {
    assert.equal(chrf('', 'next'), 0);
  });
});

describe('parseGlossary', () => {
  it('pairs the terms of each row by position and skips the header', () => {
    assert.deepEqual(parseGlossary(README), [
      { en: 'test', ja: 'テスト' },
      { en: 'test suite', ja: 'テストスイート' },
      { en: 'hosted browser', ja: 'ホスト型ブラウザ' },
      { en: 'config', ja: '設定' },
      { en: 'configuration', ja: '設定' },
    ]);
  });

  it('gives DeepL one entry per source term in either direction', () => {
    assert.deepEqual(glossaryTsv(parseGlossary(README), 'ja').split('\n'), [
      'テスト\ttest',
      'テストスイート\ttest suite',
      'ホスト型ブラウザ\thosted browser',
      '設定\tconfig',
    ]);
  });

  it('reads the real glossary in docs/ja/README.md', () => {
    const glossary = parseGlossary(readFileSync(join(REPO_ROOT, 'docs', 'ja', 'README.md'), 'utf8'));
    assert.ok(glossary.length > 20);
    assert.deepEqual(
      glossary.find((entry) => entry.en === 'hosted browser'),
      { en: 'hosted browser', ja: 'ホスト型ブラウザ' },
    );
  });
});

describe('review', () => {
  it('passes a translation DeepL agrees with', async () => {
    const [result] = await review([{ id: 'next', en: 'Next', ja: '次へ' }], fake({ Next: '次へ', 次へ: 'Next' }));
    assert.deepEqual(result?.problems, []);
    assert.equal(result?.referenceScore, 1);
  });

  it('flags a translation that drifts in both directions', async () => {
    const [result] = await review(
      [{ id: 'previous', en: 'Previous', ja: '次へ' }],
      fake({ Previous: '前のページ', 次へ: 'Next' }),
    );
    assert.deepEqual(result?.problems, ['far from the reference in both directions']);
  });

  it('passes a paraphrase that back-translates to the English', async () => {
    const [result] = await review(
      [{ id: 'thanks', en: 'Thanks for the feedback!', ja: 'ご意見ありがとうございます！' }],
      fake({
        'Thanks for the feedback!': 'フィードバックありがとうございます！',
        'ご意見ありがとうございます！': 'Thanks for the feedback!',
      }),
    );
    assert.deepEqual(result?.problems, []);
  });

  it('flags a section left in English', async () => {
    const [result] = await review([{ id: 'menu', en: 'Run a test', ja: 'Run a test' }], fake({}));
    assert.deepEqual(result?.problems, ['left in English']);
  });

  it('flags a glossary term DeepL used and ours did not', async () => {
    const [result] = await review(
      [{ id: 'web', en: 'Run the tests on a hosted browser.', ja: 'ホストされたブラウザでテストを実行します。' }],
      fake({
        'Run the tests on a hosted browser.': 'ホスト型ブラウザでテストを実行します。',
        'ホストされたブラウザでテストを実行します。': 'Run the tests on a hosted browser.',
      }),
      parseGlossary(README),
    );
    assert.deepEqual(result?.problems, ['glossary: hosted browser → ホスト型ブラウザ']);
  });
});

describe('sections', () => {
  it('splits at headings and keeps what a reader reads', () => {
    const page = [
      '---',
      'title: Quickstart',
      'description: "Set up e2e."',
      '"og:image": "https://e2e.com/x.png"',
      '---',
      '',
      "import { Video } from '../snippets/video.jsx';",
      '',
      '## Install',
      '',
      'Run `npx e2e init` in [your app](/web#install).',
      '',
      '```bash',
      '# not a heading',
      'npx e2e init',
      '```',
      '',
      '<Tab title="Web">',
      '| To | Set |',
      '| --- | --- |',
      '| point at your app | `target` |',
      '</Tab>',
      '',
      '### Next',
      '',
      '<Card title="Core concepts" href="/concepts">Goals and **assertions**.</Card>',
    ].join('\n');
    assert.deepEqual(sections(page), [
      { heading: 'frontmatter', line: 1, text: 'Quickstart Set up e2e.' },
      { heading: 'introduction', line: 6, text: '' },
      { heading: 'Install', line: 9, text: 'Install Run in your app. Web To Set point at your app' },
      { heading: 'Next', line: 24, text: 'Next Core concepts Goals and assertions .' },
    ]);
  });

  it('pairs the real quickstart with its translation section by section', () => {
    const english = sections(readFileSync(join(REPO_ROOT, 'docs', 'quickstart.mdx'), 'utf8'));
    const japanese = sections(readFileSync(join(REPO_ROOT, 'docs', 'ja', 'quickstart.mdx'), 'utf8'));
    assert.equal(japanese.length, english.length);
    assert.deepEqual(
      japanese.map((section) => section.text === ''),
      english.map((section) => section.text === ''),
    );
  });
});

describe('deepl', () => {
  it('uploads the glossary once, reuses it by name, and translates in order', async () => {
    const calls: { url: string; body?: Record<string, unknown> }[] = [];
    let glossaries: { glossary_id: string; name: string }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, ...(body ? { body } : {}) });
      if (url.endsWith('/v3/glossaries') && init?.method === 'POST') {
        glossaries = [{ glossary_id: 'g1', name: String(body?.['name']) }];
        return Response.json({ glossary_id: 'g1' });
      }
      if (url.endsWith('/v3/glossaries')) return Response.json({ glossaries });
      return Response.json({ translations: ((body?.['text'] ?? []) as string[]).map((text) => ({ text: `${text}!` })) });
    }) as typeof fetch;
    const glossary = parseGlossary(README);

    assert.deepEqual(await deepl('key:fx', glossary, fetchImpl).translate(['a', 'b'], 'EN', 'JA'), ['a!', 'b!']);
    await deepl('key:fx', glossary, fetchImpl).translate(['c'], 'JA', 'EN');

    assert.deepEqual(
      calls.map((call) => call.url),
      [
        'https://api-free.deepl.com/v3/glossaries',
        'https://api-free.deepl.com/v3/glossaries',
        'https://api-free.deepl.com/v2/translate',
        'https://api-free.deepl.com/v3/glossaries',
        'https://api-free.deepl.com/v2/translate',
      ],
    );
    assert.partialDeepStrictEqual(calls[2]?.body, {
      source_lang: 'EN',
      target_lang: 'JA',
      formality: 'prefer_more',
      glossary_id: 'g1',
    });
    assert.partialDeepStrictEqual(calls[4]?.body, { source_lang: 'JA', target_lang: 'EN-US' });
  });

  it("reads the month's usage", async () => {
    const fetchImpl = (async () => Response.json({ character_count: 1200, character_limit: 500000 })) as unknown as typeof fetch;
    assert.deepEqual(await deepl('key:fx', [], fetchImpl).usage(), { count: 1200, limit: 500000 });
  });

  it("fails with DeepL's message on an error it should not retry", async () => {
    const fetchImpl = (async () => new Response('Bad request', { status: 400 })) as unknown as typeof fetch;
    await assert.rejects(deepl('key', [], fetchImpl).translate(['a'], 'EN', 'JA'), {
      message: /^DeepL \/v2\/translate answered 400: Bad request/,
    });
  });

  it('tells a used-up quota apart', async () => {
    const fetchImpl = (async () => new Response('Quota exceeded', { status: 456 })) as unknown as typeof fetch;
    await assert.rejects(deepl('key', [], fetchImpl).translate(['a'], 'EN', 'JA'), QuotaExceeded);
  });
});

describe('gateway', () => {
  it('asks the model for one translation per text, with the glossary', async () => {
    const bodies: { model: string; messages: { content: string }[] }[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string; messages: { content: string }[] };
      bodies.push(body);
      const { texts } = JSON.parse(body.messages[1]!.content) as { texts: string[] };
      return Response.json({
        choices: [{ message: { content: JSON.stringify({ translations: texts.map((t) => `${t}!`) }) } }],
      });
    }) as typeof fetch;
    const translator = gateway('key', parseGlossary(README), fetchImpl);
    const texts = Array.from({ length: 25 }, (_, i) => `t${i}`);

    assert.deepEqual(await translator.translate(texts, 'EN', 'JA'), texts.map((t) => `${t}!`));
    assert.equal(translator.name, 'openai/gpt-6-luna');
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0]?.model, 'openai/gpt-6-luna');
    assert.match(bodies[0]?.messages[0]?.content ?? '', /hosted browser = ホスト型ブラウザ/);
  });

  it('sends a long section in a request of its own', async () => {
    let requests = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      requests++;
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const { texts } = JSON.parse(body.messages[1]!.content) as { texts: string[] };
      return Response.json({ choices: [{ message: { content: JSON.stringify({ translations: texts }) } }] });
    }) as typeof fetch;
    await gateway('key', [], fetchImpl).translate(['a'.repeat(7_000), 'b'.repeat(7_000)], 'EN', 'JA');
    assert.equal(requests, 2);
  });
});

describe('gateway answers', () => {
  it('asks again after an answer that is not JSON', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      const content = calls === 1 ? 'Sure! Here you go:' : JSON.stringify({ translations: ['次へ'] });
      return Response.json({ choices: [{ message: { content } }] });
    }) as unknown as typeof fetch;
    assert.deepEqual(await gateway('key', [], fetchImpl).translate(['Next'], 'EN', 'JA'), ['次へ']);
    assert.equal(calls, 2);
  });
});

describe('withFallback', () => {
  const exhausted: Translator = {
    name: 'DeepL',
    translate: async () => {
      throw new QuotaExceeded('used up');
    },
  };

  it("hands the texts to the fallback once DeepL's quota is used up", async () => {
    const translator = withFallback(exhausted, fake({ Next: '次へ' }));
    assert.equal(translator.name, 'DeepL');
    assert.deepEqual(await translator.translate(['Next'], 'EN', 'JA'), ['次へ']);
    assert.equal(translator.name, 'fake');
  });

  it('rethrows the quota error without a fallback', async () => {
    await assert.rejects(withFallback(exhausted, undefined).translate(['a'], 'EN', 'JA'), QuotaExceeded);
  });
});
