/**
 * The pairing rules the benchmark READMEs promise, as functions a test can
 * call: every web scenario has a deterministic twin, and every mobile scenario
 * has an agentic entry. The runner (`check-benchmark-coverage.ts`) reads the
 * catalogs and suites and reports the gaps; this module holds the parsing and
 * the comparison so the rules are covered beside the other check helpers.
 */

/** The scenario slugs a web catalog source declares, in file order: every quoted `slug:` property, in either quote style. */
export function webSlugs(source: string): string[] {
  return [...source.matchAll(/\bslug:\s*(['"])(.*?)\1/g)].map((match) => match[2]!);
}

/** The scenario names a mobile catalog source declares, in file order: every quoted `name:` property, whatever else the entry orders around it. */
export function mobileNames(source: string): string[] {
  return [...source.matchAll(/\bname:\s*(['"])(.*?)\1/g)].map((match) => match[2]!);
}

/**
 * The `slug:` properties a web catalog declares that `webSlugs` cannot read,
 * as problems, so a reformatted entry fails the check instead of quietly
 * hiding a scenario.
 */
export function unreadableWebSlugs(source: string): string[] {
  return unreadable(source, 'slug', 'web');
}

/** The `name:` properties a mobile catalog declares that `mobileNames` cannot read, as problems, like `unreadableWebSlugs`. */
export function unreadableMobileNames(source: string): string[] {
  return unreadable(source, 'name', 'mobile');
}

/** Every `key:` property in `source` whose value is neither a quoted string nor a type declaration's `key: <type>;` field. */
function unreadable(source: string, key: 'slug' | 'name', side: 'web' | 'mobile'): string[] {
  return [...source.matchAll(new RegExp(`\\b${key}\\s*:([^\\n]*)`, 'g'))]
    .map((match) => (match[1] ?? '').trim())
    .filter((value) => !/^(['"])[^\n]*?\1/.test(value) && !/^[A-Za-z_][\w.$<>[\]|]*\s*;$/.test(value))
    .map((value) => `${side}: the catalog declares a ${key} this check cannot read: ${bounded(value)}; write it as a quoted ${key}, such as ${key}: "name"`);
}

/** `value` up to the entry's separator, short enough for one line of output. */
function bounded(value: string): string {
  const [first = ''] = value.split(/[,}]/);
  const trimmed = first.trim();
  return trimmed.length > 40 ? `${trimmed.slice(0, 40)}...` : trimmed;
}

/** One web pairing rule: the catalog's slugs and the deterministic suite's files. */
export interface WebCoverage {
  readonly slugs: readonly string[];
  readonly testFiles: ReadonlySet<string>;
}

/**
 * The web benchmark's gaps: a catalog slug with no `tests/<slug>.e2e.ts`.
 * The agentic suite is intentionally partial (no web agentic check), only
 * the deterministic twin the README promises every scenario.
 */
export function webProblems(coverage: WebCoverage): string[] {
  const problems: string[] = [];
  for (const slug of coverage.slugs) {
    if (!coverage.testFiles.has(`${slug}.e2e.ts`)) {
      problems.push(`web: ${slug} has no tests/${slug}.e2e.ts; the README promises every scenario a deterministic twin`);
    }
  }
  return problems;
}

/** One mobile pairing rule: the catalog's names, the agentic suite's source, and the names allowed to have no agentic entry. */
export interface MobileCoverage {
  readonly names: readonly string[];
  readonly scenariosSource: string;
  readonly withoutAgent: readonly string[];
}

/**
 * The mobile benchmark's gaps: a catalog name with no entry in
 * `tests-agent/scenarios.e2e.ts`, outside the names allowed to have none.
 */
export function mobileProblems(coverage: MobileCoverage): string[] {
  const excluded = new Set(coverage.withoutAgent);
  return coverage.names
    .filter((name) => !excluded.has(name) && !declaresName(coverage.scenariosSource, name))
    .map((name) => `mobile: ${name} has no entry in tests-agent/scenarios.e2e.ts; the README promises one agent.act per scenario`);
}

/**
 * Whether `source` declares a `name` property for `name`, in either quote
 * style and not commented out, so formatting or a commented-out entry never
 * hides one. Comment lines are dropped first, which is enough for a catalog
 * that keeps one property per line.
 */
function declaresName(source: string, name: string): boolean {
  return mobileNames(uncommented(source)).includes(name);
}

/** `source` without its `//` line comments and its block comments, which stand in as empty lines. */
function uncommented(source: string): string {
  let inBlock = false;
  return source
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      if (inBlock) {
        inBlock = !trimmed.includes('*/');
        return '';
      }
      if (trimmed.startsWith('/*')) {
        inBlock = !trimmed.includes('*/');
        return '';
      }
      return trimmed.startsWith('//') ? '' : line;
    })
    .join('\n');
}
