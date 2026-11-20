/**
 * Fails when a benchmark scenario ships without its test.
 *
 * `apps/web-benchmark/README.md` promises every scenario a deterministic twin
 * (`tests/<slug>.e2e.ts`), and `apps/mobile-benchmark/README.md` promises one
 * `agent.act` per scenario. The web side checks the deterministic twin only,
 * since the web agentic suite is intentionally partial; the mobile side
 * checks the agentic list with one documented exception, the Control
 * Inventory the agentic suite deliberately leaves out (a new exception needs
 * a written reason). A catalog whose parse finds no scenarios fails too, so a
 * format change cannot pass the check by checking nothing.
 *
 * Usage: `node scripts/check-benchmark-coverage.ts`, part of `pnpm check`.
 * Exits 1 listing every gap.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mobileNames, mobileProblems, unreadableMobileNames, unreadableWebSlugs, webProblems, webSlugs } from './benchmark-coverage.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Mobile names the agentic suite deliberately leaves out, from `apps/mobile-benchmark/README.md`. */
const MOBILE_WITHOUT_AGENT = ['Control Inventory'];

const webDir = join(ROOT, 'apps', 'web-benchmark');
const mobileDir = join(ROOT, 'apps', 'mobile-benchmark');

const webSource = readFileSync(join(webDir, 'app', 'src', 'examples.ts'), 'utf8');
const testFiles = new Set(readdirSync(join(webDir, 'tests')).filter((file) => file.endsWith('.e2e.ts')));

const mobileSource = readFileSync(join(mobileDir, 'src', 'examples.ts'), 'utf8');
const scenariosSource = readFileSync(join(mobileDir, 'tests-agent', 'scenarios.e2e.ts'), 'utf8');

const slugs = webSlugs(webSource);
const names = mobileNames(mobileSource);

if (slugs.length === 0 || names.length === 0) {
  const empty = [slugs.length === 0 ? 'web' : undefined, names.length === 0 ? 'mobile' : undefined].filter(Boolean).join(' and ');
  process.stderr.write(`benchmark coverage: the ${empty} catalog parses to no scenarios; nothing was checked\n`);
  process.exitCode = 1;
} else {
  const problems = [
    ...unreadableWebSlugs(webSource),
    ...unreadableMobileNames(mobileSource),
    ...webProblems({ slugs, testFiles }),
    ...mobileProblems({ names, scenariosSource, withoutAgent: MOBILE_WITHOUT_AGENT }),
  ];
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`benchmark coverage: ${slugs.length} web scenarios and ${names.length} mobile scenarios have their tests\n`);
  }
}
