/**
 * The runner's config: the project config `@e2e-dev/core` resolves too
 * (`resolveProjectConfig`), plus the reporters and test filters only a run
 * reads.
 */

import { ConfigurationError } from '@e2e-dev/core/lib/internal/errors';
import { didYouMean } from '@e2e-dev/core/lib/internal/suggest';
import { BUILTIN_REPORTER_LIST, builtinReporter } from '../report/builtin.ts';
import { BUILTIN_REPORTERS, builtinMark, isBuiltinReporter } from '../report/builtin-id.ts';
import { ellipsize } from '../report/format.ts';
import type { BuiltinReporter, E2EConfig, Reporter, TestFilter } from '../run-types.ts';
import { resolveProjectConfig, type CliOverrides, type ResolvedConfig } from '@e2e-dev/core/lib/config/resolve';
import { TARGET_NAME_PATTERN } from '@e2e-dev/core/lib/config/targets';

/** A resolved config with what only a run reads. */
export interface ResolvedRunConfig extends ResolvedConfig {
  /**
   * Every reporter in force, the built-ins first: the ones `--reporter`
   * names when given, else the config's, then every other reporter the
   * config names. At most one prints to each terminal stream.
   */
  readonly reporters: readonly Reporter[];
  /** The test filters, in order; empty when unset. A run with `--changed-since` applies them. */
  readonly filters: readonly TestFilter[];
}

/** The flags that replace config keys, `--reporter` among them. */
export interface RunCliOverrides extends CliOverrides {
  reporters?: readonly BuiltinReporter[];
}

/** Resolves a config file's export for the runner: the project config, then its reporters and filters. */
export function resolveConfig(
  raw: E2EConfig,
  options: {
    projectRoot: string;
    configPath?: string;
    env?: NodeJS.ProcessEnv;
    cli?: RunCliOverrides;
  },
): ResolvedRunConfig {
  const resolved = resolveProjectConfig(raw, options);
  return { ...resolved, reporters: resolveReporters(raw, options.cli ?? {}), filters: resolveTestFilters(raw.filters) };
}

/**
 * Resolves `reporters` into reporter objects, an id into its built-in
 * factory's reporter with default options. `--reporter` replaces the
 * built-ins only, keeping the options of one the config configured: a
 * third-party reporter has no id to name on the command line, so a CI flag
 * choosing `list,junit` never drops the upload a config asked for. One
 * interactive reporter at most shows the run. A `list`, `dot`, or `line` id, or
 * its factory called without a `stream`, prints to stderr beside `json`,
 * leaving stdout to the report. An id named twice runs once.
 * Workers resolve this too and never call a reporter, which the factories
 * allow: constructing one has no side effects.
 */
function resolveReporters(raw: E2EConfig, cli: RunCliOverrides): readonly Reporter[] {
  const configured = raw.reporters ?? ['list'];
  if (!Array.isArray(configured)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'reporters must be an array of reporter ids and reporter objects',
    );
  }
  // A built-in named by id is made once the selection is known, since
  // `list`, `dot`, and `line` print to stderr beside `json`.
  type Built = { readonly id: BuiltinReporter; readonly reporter: Reporter | undefined };
  const builtins: Built[] = [];
  const others: Reporter[] = [];
  const addId = (id: BuiltinReporter): void => {
    if (!builtins.some((entry) => entry.id === id && entry.reporter === undefined)) builtins.push({ id, reporter: undefined });
  };
  for (const [index, entry] of (configured as readonly unknown[]).entries()) {
    const resolved = resolveReporter(entry, `reporters[${index}]`);
    const mark = typeof resolved === 'string' ? undefined : builtinMark(resolved);
    if (typeof resolved === 'string') addId(resolved);
    else if (mark === undefined) others.push(resolved);
    else if (mark.asId) addId(mark.id);
    else builtins.push({ id: mark.id, reporter: resolved });
  }
  const chosen: readonly Built[] =
    cli.reporters === undefined
      ? builtins
      : [...new Set(cli.reporters)].flatMap((id) => {
          const same = builtins.filter((entry) => entry.id === id);
          return same.length > 0 ? same : [{ id, reporter: undefined }];
        });
  const stream = chosen.some((entry) => entry.id === 'json') ? 'stderr' : 'stdout';
  const reporters = [...chosen.map((entry) => entry.reporter ?? builtinReporter(entry.id, stream)), ...others];
  const showing = reporters.filter((reporter) => reporter.interactive === true);
  if (showing.length > 1) {
    const names = showing.map((reporter) => `"${reporter.name}"`);
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `reporters ${names.slice(0, -1).join(', ')} and ${names.at(-1)} are all interactive: each would show the run in the terminal, everything printed twice; run one of them`,
    );
  }
  // A view by id moved to stderr above; one told to print to stdout would garble the document.
  const onStdout = chosen.find((entry) => entry.reporter !== undefined && builtinMark(entry.reporter)?.stream === 'stdout');
  if (onStdout !== undefined && chosen.some((entry) => entry.id === 'json')) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `reporters "${onStdout.id}" and "json" both print to stdout, where the run would garble the report; drop the stream option or run one of them`,
    );
  }
  return reporters;
}

/** One entry of `reporters`: a built-in id, or an object checked structurally, never with `instanceof`. */
function resolveReporter(entry: unknown, label: string): BuiltinReporter | Reporter {
  if (typeof entry === 'string') {
    if (!isBuiltinReporter(entry)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `unknown reporter "${entry}"; reporters are ${BUILTIN_REPORTER_LIST}${didYouMean(entry, BUILTIN_REPORTERS)}`,
      );
    }
    return entry;
  }
  if (typeof entry === 'function') {
    throw new ConfigurationError('INVALID_CONFIG', `${label} is ${entry.name ? `the function ${entry.name}` : 'a function'}; call it, such as reporters: [junit()]`);
  }
  if (!isReporter(entry)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label} must be a built-in id (${BUILTIN_REPORTERS.join(', ')}) or a reporter: a name, an optional interactive flag, and at least one of onEvent, reportFiles, onRunFinished, and onSummary`,
    );
  }
  return entry;
}

const MAX_FILTER_NAME = 256;

/**
 * Resolves `filters`: a list of test filters, each checked structurally,
 * never with `instanceof`, since the config may import another copy of
 * `e2e`. A filter's name is how the report and errors tell it apart, so
 * names are unique. Workers resolve it too and never call a filter, so the
 * check stays synchronous.
 */
function resolveTestFilters(raw: E2EConfig['filters']): readonly TestFilter[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigurationError('INVALID_CONFIG', 'filters must be a list of test filters: filters: [{ name, filter(tests, context) }]');
  }
  const names = new Set<string>();
  return Array.from(raw as readonly unknown[], (value, index) => {
    const label = `filters[${index}]`;
    if (typeof value === 'function') {
      throw new ConfigurationError('INVALID_CONFIG', `${label} is ${value.name ? `the function ${value.name}` : 'a function'}; call it, such as filters: [decisionFilter({ model })]`);
    }
    if (!isTestFilter(value)) {
      throw new ConfigurationError('INVALID_CONFIG', `${label} must be a TestFilter: { name, filter(tests, context) }`);
    }
    const { name } = value;
    if (!TARGET_NAME_PATTERN.test(name)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `invalid filter name ${JSON.stringify(name)}: names are ASCII letters, numbers, "_", "-", or ".", and cannot be only dots`,
      );
    }
    if (name.length > MAX_FILTER_NAME) {
      throw new ConfigurationError('INVALID_CONFIG', `filter name ${JSON.stringify(ellipsize(name, 32))} is longer than ${MAX_FILTER_NAME} characters`);
    }
    if (names.has(name)) {
      throw new ConfigurationError('INVALID_CONFIG', `filters has two filters named ${JSON.stringify(name)}; the report tells filters apart by name`);
    }
    names.add(name);
    return value;
  });
}

/** Structural test filter check: a string name and a `filter` function. */
function isTestFilter(value: unknown): value is TestFilter {
  if (typeof value !== 'object' || value === null) return false;
  const { name, filter } = value as { name?: unknown; filter?: unknown };
  return typeof name === 'string' && typeof filter === 'function';
}

/** Structural reporter check: a non-empty name, `interactive` a boolean when present, and at least one hook, each a function when present. */
function isReporter(value: unknown): value is Reporter {
  if (typeof value !== 'object' || value === null) return false;
  const { name, interactive, onEvent, reportFiles, onRunFinished, onSummary } = value as Record<keyof Reporter, unknown>;
  if (typeof name !== 'string' || name.length === 0) return false;
  if (interactive !== undefined && typeof interactive !== 'boolean') return false;
  const hooks = [onEvent, reportFiles, onRunFinished, onSummary];
  return hooks.every((hook) => hook === undefined || typeof hook === 'function') && hooks.some((hook) => hook !== undefined);
}
