import { packageVersion } from '@e2e-dev/core/lib/internal/package-version';
import type { PackageManager } from '../../internal/package-manager.ts';
import { getEnginePreset, type EngineId, type EnginePreset } from './engines.ts';
import type { FrameworkApp } from './frameworks.ts';
import { dependencyRange, siblingDependency } from './versions.ts';
import { AI_DEPENDENCIES, getGatewayPreset, type GatewayId } from './gateways.ts';

/** The model choice `init` writes: which gateway, and for an OpenAI-compatible one, where. */
export interface ScaffoldModel {
  readonly gateway: GatewayId;
  readonly endpoint?: string;
}

/**
 * The agents block. The model is a constructed AI SDK instance from the chosen
 * gateway's own package, written out in full, so a reader sees where every
 * model call goes and which variable holds the key without knowing any e2e
 * default; there is none.
 */
function agentConfig(model: ScaffoldModel): string {
  const preset = getGatewayPreset(model.gateway);
  return `  // ${preset.comment}
  agents: {
    default: {
      model: ${preset.model(model.endpoint)},
      system: 'You are a thorough QA agent. Verify every outcome.',
    },
  },`;
}

/** One test file the scaffold writes, as `tests/<name>.e2e.ts`. */
interface ScaffoldTest {
  readonly name: string;
  readonly content: string;
}

const NO_ENGINE_CONFIG = `  // Add an engine here when your tests need to drive an app.
  targets: [{ name: 'default', platform: 'custom' }],`;

const NO_ENGINE_EXAMPLE = `import { test, expect } from 'e2e';

test('app responds', async () => {
  const response = await fetch(process.env.APP_URL ?? 'http://localhost:3000');
  expect(response.ok).toBe(true);
});
`;

/** A detected app the web target starts with the project's package manager. */
export interface ScaffoldApp {
  readonly app: FrameworkApp;
  readonly manager: PackageManager;
}

/** The line that tells a config whether it runs in CI, the way the runner reads `CI`. */
const CI_CONSTANT = `// e2e reads CI the same way: unset, '', '0', and 'false' mean a local run.
const ci = !['', '0', 'false'].includes(process.env.CI?.trim().toLowerCase() ?? '');`;

/** An `app.command` that runs a package.json script with the project's package manager. */
function scriptCommand(manager: PackageManager, script: string, reuse: boolean): string {
  return `{ executable: '${manager}', args: ['run', '${script}']${reuse ? ', reuseExisting: true' : ''} }`;
}

/**
 * The web target for a detected app: its URL, and the command that starts
 * it. Locally the runner starts the dev server or reuses one already on the
 * port; in CI, when the project has a production build, it serves the build
 * the pipeline made.
 */
function appTarget({ app, manager }: ScaffoldApp): string {
  const dev = scriptCommand(manager, app.dev, true);
  const command = app.production === undefined
    ? [
      `    // The runner starts the ${app.framework} dev server, or uses one you already started on that port.`,
      `    command: ${dev},`,
    ]
    : [
      `    // ${app.framework}: the dev server here, or one you already started on that port.`,
      `    // CI serves the production build: run \`${manager} run ${app.production.build}\` before \`e2e run\`.`,
      '    command: ci',
      `      ? ${scriptCommand(manager, app.production.start, false)}`,
      `      : ${dev},`,
    ];
  return ['{', '  engine: web(),', '  app: {', `    url: '${app.url}',`, ...command, '  },', '}'].join('\n');
}

/** Every line of `text` after the first indented by `prefix`, for a block nested one level deeper. */
function indentTail(text: string, prefix: string): string {
  return text.replaceAll('\n', `\n${prefix}`);
}

/**
 * The `targets` field and the settings the engines add. One engine keeps its
 * target inline; several get one entry each, and a setting two engines share
 * is written once.
 */
function targetsConfig(engines: readonly EnginePreset[], app: ScaffoldApp | undefined): string {
  const target = (preset: EnginePreset): string => (preset.id === 'web' && app !== undefined ? appTarget(app) : preset.target);
  const [engine, ...others] = engines;
  if (engine === undefined) return NO_ENGINE_CONFIG;
  const settings = [...new Set(engines.flatMap((preset) => preset.settings))];
  if (others.length === 0) {
    return [
      ...(engine.targetComment === undefined ? [] : [`  // ${engine.targetComment}`]),
      `  targets: [${indentTail(target(engine), '  ')}],`,
      ...settings,
    ].join('\n');
  }
  return [
    '  targets: [',
    ...engines.flatMap((preset) => [
      ...(preset.targetComment === undefined ? [] : [`    // ${preset.targetComment}`]),
      `    ${indentTail(target(preset), '    ')},`,
    ]),
    '  ],',
    ...settings,
  ].join('\n');
}

/**
 * The example tests. One engine writes `tests/example.e2e.ts`; several write
 * one file per engine, each test scoped to its engine's platform so the other
 * engines' targets skip it.
 */
function exampleTests(engines: readonly EnginePreset[], ai: boolean): ScaffoldTest[] {
  const [engine, ...others] = engines;
  if (engine === undefined) return [{ name: 'example', content: NO_ENGINE_EXAMPLE }];
  if (others.length === 0) return [{ name: 'example', content: engine.example('') + (ai ? engine.aiExample('') : '') }];
  return engines.map((preset) => {
    const options = `{ platforms: ['${preset.platform}'] }, `;
    return { name: preset.file, content: preset.example(options) + (ai ? preset.aiExample(options) : '') };
  });
}

/**
 * Composes common setup, the selected engines (none for an engine-less
 * config), and optional AI support. With `app`, the web target starts the
 * detected app instead of reading `APP_URL`.
 */
export function createScaffold(engineIds: readonly EngineId[], model: ScaffoldModel | undefined, app?: ScaffoldApp) {
  const engines = engineIds.map(getEnginePreset);
  const gateway = model === undefined ? undefined : getGatewayPreset(model.gateway);
  const imports = [
    "import type { E2EConfig } from 'e2e';",
    ...engines.flatMap((engine) => engine.imports),
    ...(gateway === undefined ? [] : [gateway.import]),
  ];
  const configFields = [
    ...(model === undefined ? [] : [agentConfig(model)]),
    targetsConfig(engines, app),
  ];
  // Only the web target reads the detected app, and only one with a production build switches on CI.
  const webApp = engines.some((engine) => engine.id === 'web') ? app : undefined;
  const preamble = webApp?.app.production === undefined ? '' : `${CI_CONSTANT}\n\n`;

  return {
    dependencies: {
      'e2e': dependencyRange(packageVersion(import.meta.url, '../../../package.json', '0.0.0')),
      ...Object.fromEntries(engines.flatMap((engine) => Object.entries(engine.dependencies))),
      // Every engine peers on `@e2e-dev/core`; npm and pnpm install peers, Yarn does not, and Plug'n'Play then cannot load the engine.
      ...(engines.length === 0 ? {} : siblingDependency('@e2e-dev/core')),
      ...(gateway === undefined ? {} : { ...AI_DEPENDENCIES, ...gateway.dependencies }),
    },
    config: `${imports.join('\n')}

${preamble}export default {
${configFields.join('\n')}
} satisfies E2EConfig;
`,
    tests: exampleTests(engines, gateway !== undefined),
    // An engine-less config's example fetches APP_URL too; a detected app's target has its own URL.
    needsAppUrl: engines.length === 0 || engines.some((engine) => engine.needsAppUrl && !(engine.id === 'web' && webApp !== undefined)),
    /** Whether the config starts the app, which a fresh CI machine needs. */
    startsApp: webApp !== undefined,
  };
}
