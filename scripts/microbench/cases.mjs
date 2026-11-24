/**
 * The microbenchmark cases `scripts/microbench.ts` measures: small pure-JS
 * functions the runner calls per step, per observation, or per node, run
 * without a browser or a device.
 *
 * A case loads the code under test from `root`, a checkout whose packages are
 * built, so the same case measures a base and a head build. Its inputs come
 * from this checkout (the harness), never from `root`: both builds read the
 * same bytes. Every module a case loads is reached by its `dist` path, so a
 * rename on one side fails that case loudly instead of measuring something
 * else.
 *
 * Plain JavaScript, because `--jitless` turns off WebAssembly and Node's
 * TypeScript stripping needs it.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HARNESS_ROOT = path.resolve(import.meta.dirname, '../..');
const SNAPSHOTS = path.join(HARNESS_ROOT, 'packages/mobile/tests/fixtures/snapshots');

/** Imports a built module of the checkout under test. */
function load(root, relative) {
  return import(pathToFileURL(path.join(root, relative)).href);
}

/** A captured agent-device snapshot of the mobile benchmark. */
function snapshot(platform, scenario) {
  return JSON.parse(readFileSync(path.join(SNAPSHOTS, platform, `${scenario}.json`), 'utf8'));
}

/** Values with characters that JSON escapes and URL encoding rewrites, so each spelling below differs from the raw value. */
const SECRETS = [
  ['password', 'correct horse/battery"staple'],
  ['apiKey', 'sk-live+4f9a/8b7c=6d5e4f3a'],
  ['otp', '482913'],
];

/** The spellings each secret is planted in: raw, JSON-escaped, URL-encoded, and upper case. */
function spellings(value) {
  return [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), value.toUpperCase()];
}

/**
 * About 50 KB of screen text the way a model reads it: every committed tree
 * of the mobile benchmark, with each secret planted once in every spelling
 * redaction has to catch.
 */
function screenText() {
  const lines = [];
  for (const platform of ['android', 'ios']) {
    const dir = path.join(SNAPSHOTS, platform);
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.tree.txt')).toSorted()) {
      lines.push(...readFileSync(path.join(dir, file), 'utf8').split('\n'));
    }
  }
  const plants = SECRETS.flatMap(([, value]) => {
    const [raw, json, url, upper] = spellings(value);
    return [`textbox "Password" value=${raw}`, `text "${json}"`, `link "https://example.test/cb?token=${url}"`, `text ${upper}`];
  });
  const step = Math.floor(lines.length / (plants.length + 1));
  plants.forEach((line, index) => lines.splice((index + 1) * step, 0, line));
  return lines.join('\n');
}

/** Checks a redacted text: no spelling of any secret is left, and each planted spelling became a marker. */
function checkRedacted(result) {
  assert.equal(typeof result, 'string');
  for (const [name, value] of SECRETS) {
    for (const spelling of spellings(value)) assert(!result.includes(spelling), `${name} survived redaction as ${JSON.stringify(spelling)}`);
    const markers = result.split(`<secret:${name}>`).length - 1;
    assert(markers >= spellings(value).length, `${name} left ${markers} markers for ${spellings(value).length} plants`);
  }
}

/**
 * A product catalog of `count` cards under one list, the shape a long
 * scrolled screen reads as: each card a list item holding a heading, a price,
 * and two buttons.
 */
function catalogTree(count) {
  let next = 0;
  const node = (fields, children) => ({
    ref: { id: `n${(next += 1)}`, revision: 'r1' },
    ...fields,
    ...(children === undefined ? {} : { children }),
  });
  const cards = [];
  for (let i = 0; i < count; i += 1) {
    cards.push(
      node({ role: 'listitem', name: `Product ${i}` }, [
        node({ role: 'heading', name: `Product ${i}`, level: 2 }),
        node({ role: 'text', name: `$${(i * 7) % 100}.99`, text: `$${(i * 7) % 100}.99` }),
        node({ role: 'button', name: `Add Product ${i} to cart`, testId: `add-${i}` }),
        node({ role: 'button', name: 'Details', ...(i % 5 === 0 ? { states: { disabled: true } } : {}) }),
      ]),
    );
  }
  return [
    node({ role: 'main', name: 'Catalog' }, [
      node({ role: 'navigation', name: 'Primary' }, [
        node({ role: 'link', name: 'Home' }),
        node({ role: 'link', name: 'Cart' }),
      ]),
      node({ role: 'list', name: 'Products' }, cards),
    ]),
  ];
}

const text = (value, exact = true) => ({ kind: 'string', value, exact });

/**
 * Each case: `name` (`<area>/<input>`, stable across revisions), `warmup`
 * iterations run before the measured loop so tier-up happens there, the
 * smallest measured `iterations` count, and `load(root)`, which builds a
 * workload: `run()` is one iteration, `check(result)` validates the last
 * result outside the measured loop.
 */
export const CASES = [
  {
    name: 'redact/screen-text',
    description: 'SecretLedger.redact over 50 KB of screen text with three secrets',
    warmup: 600,
    iterations: 600,
    async load(root) {
      const { SecretLedger } = await load(root, 'packages/core/dist/internal/redact.js');
      const ledger = new SecretLedger(SECRETS);
      const input = screenText();
      return { run: () => ledger.redact(input), check: checkRedacted };
    },
  },
  {
    name: 'redact/fragments',
    description: 'SecretLedger.redactFragments over the same text',
    warmup: 3,
    iterations: 6,
    async load(root) {
      const { SecretLedger } = await load(root, 'packages/core/dist/internal/redact.js');
      const ledger = new SecretLedger(SECRETS);
      const input = screenText();
      return { run: () => ledger.redactFragments(input), check: checkRedacted };
    },
  },
  {
    name: 'locate/catalog',
    description: 'resolveExpression: a role, a text, and a filtered query over a 400-card tree',
    warmup: 15,
    iterations: 15,
    async load(root) {
      const { resolveExpression } = await load(root, 'packages/core/dist/engine/index.js');
      const tree = catalogTree(400);
      const expressions = [
        { kind: 'query', query: { kind: 'role', value: text('button'), name: text('Add Product 317 to cart') } },
        { kind: 'query', query: { kind: 'text', value: text('product 25', false) } },
        {
          kind: 'index',
          index: 'first',
          source: {
            kind: 'filter',
            source: { kind: 'query', query: { kind: 'role', value: text('listitem') } },
            hasText: text('$43.99', false),
            has: { kind: 'query', query: { kind: 'role', value: text('button'), states: { disabled: false } } },
          },
        },
      ];
      return {
        run: () => expressions.map((expression) => resolveExpression(expression, tree).length),
        check: (counts) => assert.deepEqual(counts, [1, 22, 1]),
      };
    },
  },
  {
    name: 'mobile/project-snapshot',
    description: 'projectSnapshot of every captured Android and iOS screen of the mobile benchmark',
    warmup: 4,
    iterations: 8,
    async load(root) {
      const { keyboardBand, projectSnapshot } = await load(root, 'packages/mobile/dist/nodes.js');
      const captures = ['android', 'ios'].flatMap((platform) =>
        readdirSync(path.join(SNAPSHOTS, platform))
          .filter((name) => name.endsWith('.json'))
          .toSorted()
          .map((name) => snapshot(platform, name.slice(0, -'.json'.length))),
      );
      const project = (capture) => {
        let counter = 0;
        return projectSnapshot(capture.nodes, {
          mintId: () => `n${(counter += 1)}`,
          viewport: capture.viewport,
          keyboard: keyboardBand(capture.nodes, capture.keyboard, capture.viewport),
        }).index.length;
      };
      return {
        run: () => captures.map(project),
        check: (counts) => {
          assert.equal(counts.length, captures.length);
          for (const count of counts) assert(count > 0, 'a capture projected no nodes');
        },
      };
    },
  },
];
