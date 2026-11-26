/** Attempt-scoped fixture graph. */

import path from 'node:path';
import { BUILT_IN_AGENT } from '../agent/agent-brand.ts';
import { createAgentFixture } from '../agent/index.ts';
import { prepareObservation, type NodeRedaction } from '../agent/observation.ts';
import type { AgentContext, AgentSelection } from '../agent/invocation.ts';
import type { ExecutorAttempt, StepExecutor } from '../agent/executor.ts';
import type { AgentCacheContext } from '../cache/context.ts';
import type { WorkerModels } from './worker-models.ts';
import type { EngineCapability, EngineFixtureContext } from '../engine/index.ts';
import type { OperationContext, TargetSession } from '../engine/surface.ts';
import { expectationBrand } from '../internal/brands.ts';
import type { DebugTrace } from '../internal/debug.ts';
import { ConfigurationError, errorMessage, InfrastructureError, TestError } from '../internal/errors.ts';
import { Deadline } from '../internal/time.ts';
import { didYouMean } from '../internal/suggest.ts';
import { createScreenshotContext, type ScreenshotContext, type WrittenScreenshots } from './screenshots.ts';
import { sessionRecordings } from './recordings.ts';
import { resolveSecretValue, sessionLedger } from './secrecy.ts';
import { baseUrlOf, resolveNavigationUrl } from '../internal/urls.ts';
import { FixtureRecorder } from './fixture-recording.ts';
import { createRequest } from './request.ts';
import type { AttemptBudget } from './budget.ts';
import { LocatorEngine } from '../locator/engine.ts';
import {
  createLocator,
  createScopedScreen,
  createScreen,
  type ScreenContext,
  type SecretResolver,
} from '../locator/screen.ts';
import { engineAppInfo, joinLink, refusesLink } from '../config/app.ts';
import type { ResolvedAgentConfig, ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import type { App, CommandConfig, Expectable, FixtureScope, RecordingOptions, SetupSession, TestFixtures } from '../types.ts';
import type { StepRecord, StepRecorder } from './steps.ts';

export interface ArtifactSink {
  /** Absolute attempt artifact directory, for runner-written artifacts. */
  readonly dir: string;
  /** Registers a produced artifact and returns its report artifact ID. */
  register(
    kind: 'screenshot' | 'video' | 'download' | 'log',
    relativePath: string,
    options?: ArtifactRegistration,
  ): string;
  /** Registers a video a hosted service keeps, by URL, and returns its report artifact ID; nothing is read or stored. */
  link(url: string, options: { readonly mediaType: string; readonly startedAt: string; readonly actor?: string | undefined }): string;
}

/** Facts about a produced artifact its file does not carry. */
export interface ArtifactRegistration {
  /** When a time-based artifact (a video segment) began recording. */
  readonly startedAt?: string;
  /** The session that produced it when it is not the test's own; see `StepRecord.actor`. */
  readonly actor?: string;
}

export interface AttemptEnvironment {
  readonly config: ResolvedConfig;
  readonly target: ResolvedTarget;
  readonly session: TargetSession;
  readonly steps: StepRecorder;
  /** The running phase's signal and deadline; read at call time, never captured. */
  readonly budget: AttemptBudget;
  readonly runId: string;
  readonly attemptId: string;
  /** The attempt as executors see it: identity, end-of-attempt signal, scratch memory. */
  readonly attempt: ExecutorAttempt;
  readonly artifacts: ArtifactSink;
  /** Completed steps agent prompts quote as prior context; serial members see the whole group. */
  readonly priorSteps: () => readonly StepRecord[];
  /** Trusted test/group agent context appended after the agent's own `context`. */
  readonly agentContext: string | undefined;
  /** The configured agent the pair runs as; undefined falls back to the run's first agent. */
  readonly agent?: string | undefined;
  /** Stages one captured session state; only setup attempts provide this. */
  readonly saveSession: ((name: string) => Promise<void>) | undefined;
  /** The attempt's trace cache context, or undefined when caching is off. */
  readonly cache?: AgentCacheContext;
  /** `--debug` phase timings; absent when the caller collects none. */
  readonly debug?: DebugTrace;
  /** The worker's model adapters, checked once on the first `agent` acquisition. */
  readonly models: WorkerModels;
  /**
   * The test the attempt runs, which `toHaveScreenshot` keeps its screenshots
   * beside, and the screenshots the run wrote; absent for a session with no
   * test (`e2e mcp`).
   */
  readonly test?: { readonly file: string; readonly titlePath: readonly string[]; readonly writtenScreenshots: WrittenScreenshots };
  /** Values of services started by the worker's entry point for the `services` fixture. Empty when omitted. */
  readonly services?: Readonly<Record<string, unknown>> | undefined;
}

/** Builds the lazy fixture graph for one attempt. */
export interface AttemptFixtures {
  readonly fixtures: TestFixtures & { readonly session: SetupSession };
  /** The runtime behind `fixtures.agent`, for a host that opens steps itself (`e2e mcp`). */
  readonly agentRuntime: AgentContext;
}

/** What a screen over one engine session is wired to. */
interface ScreenWiring {
  /** The engine session the screen drives. */
  readonly session: TargetSession;
  readonly budget: AttemptBudget;
  readonly runId: string;
  readonly attemptId: string;
  readonly config: ResolvedConfig;
  readonly steps: StepRecorder;
  readonly secrets: SecretResolver;
  readonly artifacts: ArtifactSink;
  /** The session's secret ledger, which `screen.tree()` passes its text through. */
  readonly redaction: NodeRedaction;
  /** The app URL's origin, so the tree shows a link on it by its path. */
  readonly appOrigin: string | undefined;
  /** Where `toHaveScreenshot` keeps screenshots; only a test has them. */
  readonly screenshots?: ScreenshotContext | undefined;
}

/**
 * The locator engine and screen context over one engine session, wired to the
 * attempt's budget, step recorder, timeouts, and secret resolver. The test
 * fixtures use it, and so does `e2e mcp`'s `run_code` with a session whose
 * reads pass the secret ledger.
 */
export function createScreenContext(wiring: ScreenWiring): ScreenContext {
  const { config, steps } = wiring;
  const engine = new LocatorEngine({
    session: wiring.session,
    budget: wiring.budget,
    runId: wiring.runId,
    attemptId: wiring.attemptId,
    actionTimeout: config.actionTimeout,
    assertionTimeout: config.assertionTimeout,
    recordEvent: (event) => steps.recordEvent(event),
    redact: (text) => steps.redactText(text),
  });
  return {
    engine,
    steps,
    secrets: wiring.secrets,
    artifacts: wiring.artifacts,
    projectRoot: config.projectRoot,
    renderTree: (observation) =>
      prepareObservation(observation, {
        redact: wiring.redaction.redact,
        redactCut: wiring.redaction.redactCut,
        maxBytes: config.limits.maxObservationBytes,
        appOrigin: wiring.appOrigin,
      }).text,
    ...(wiring.screenshots === undefined ? {} : { screenshots: wiring.screenshots }),
  };
}

export function createFixtures(environment: AttemptEnvironment): AttemptFixtures {
  const ledger = sessionLedger(environment.session, environment.config.allSecrets);
  const secrets: SecretResolver = {
    resolve: (secret) => resolveSecretValue(secret, environment.config.allSecrets, ledger),
  };

  const screenContext = createScreenContext({
    session: environment.session,
    budget: environment.budget,
    runId: environment.runId,
    attemptId: environment.attemptId,
    config: environment.config,
    steps: environment.steps,
    secrets,
    artifacts: environment.artifacts,
    redaction: ledger,
    appOrigin: environment.target.app.base?.origin,
    ...(environment.test === undefined
      ? {}
      : {
          screenshots: createScreenshotContext({
            projectRoot: environment.config.projectRoot,
            ci: environment.config.ci,
            update: environment.config.updateSnapshots,
            targetName: environment.target.name,
            file: environment.test.file,
            titlePath: environment.test.titlePath,
            written: environment.test.writtenScreenshots,
            artifacts: environment.artifacts,
          }),
        }),
  });
  const { engine } = screenContext;

  /**
   * The agents this attempt can run with, resolved once each: the test's pin
   * (else the run's agent) when a call names none, or any configured agent a
   * call names. Each is preflighted on first use, so a second agent's missing
   * credential surfaces where it is first needed, as one run-level failure.
   */
  const { config } = environment;
  const attemptAgentName = environment.agent ?? config.agentNames[0]!;
  const selections = new Map<string, AgentSelection>();
  const select = (requested: string | undefined): AgentSelection => {
    if (requested !== undefined && (typeof requested !== 'string' || requested === '')) {
      throw new TestError('INVALID_ARGUMENT', 'agent must be the name of a configured agent');
    }
    const name = requested ?? attemptAgentName;
    const cached = selections.get(name);
    if (cached !== undefined) return cached;
    const resolved = config.agents.get(name);
    if (resolved === undefined) {
      throw new TestError(
        'INVALID_ARGUMENT',
        `unknown agent "${name}"; configured: ${[...config.agents.keys()].join(', ')}${didYouMean(name, [...config.agents.keys()])}`,
      );
    }
    environment.models.preflight(resolved, name);
    const selection: AgentSelection = {
      name,
      config: resolved,
      executor: resolved.executor ?? lazyBuiltInAgent(resolved),
      // The built-in agent's assertions go to the judgment tier, so a
      // configured `judge` judges them. Only a custom executor judges its
      // own assertions through `runStep`.
      customExecutor: resolved.executor !== undefined,
      // Built on first use: a run whose `agent.act()` steps go to a custom
      // executor may have no model at all and must not fail on a
      // MODEL_UNAVAILABLE it would never hit; a judgment still fails with it
      // on its first call.
      judge: lazily(() => environment.models.build(resolved.judge, name)),
      agentContext: joinAgentContext(resolved.context, environment.agentContext),
    };
    selections.set(name, selection);
    return selection;
  };

  const agentRuntime: AgentContext = {
    engine,
    engineCapabilities: environment.target.engine?.capabilities ?? new Set<EngineCapability>(),
    steps: environment.steps,
    select,
    reportUnservedModel: environment.models.unservedModel,
    config: environment.config,
    target: {
      name: environment.target.name,
      platform: environment.target.platform,
      verbs: environment.session.verbs,
      tapModifiers: environment.session.tapModifiers,
    },
    app: environment.target.app,
    attempt: environment.attempt,
    priorSteps: environment.priorSteps,
    secrets,
    redact: ledger.redact,
    redactCut: ledger.redactCut,
    artifacts: environment.artifacts,
    ...(environment.cache !== undefined ? { cache: environment.cache } : {}),
    ...(environment.debug !== undefined ? { debug: environment.debug } : {}),
  };

  const context: CoreFixtureContext = { environment, engine, screenContext, agentRuntime };
  const factories: Record<string, () => unknown> = {};
  for (const [name, fixture] of Object.entries(CORE_FIXTURES)) {
    factories[name] = 'ofWorker' in fixture ? () => fixture.ofWorker({ target: environment.target, services: environment.services ?? {} }) : () => fixture.create(context);
  }
  Object.assign(factories, contributedFactories(environment, engine, screenContext));
  // Accessors: a fixture is built on first touch, whether or not the test body reaches it, and kept.
  const fixtures = {} as AttemptFixtures['fixtures'];
  for (const [name, create] of Object.entries(factories)) {
    Object.defineProperty(fixtures, name, { enumerable: true, get: lazily(create) });
  }

  return { fixtures: gateUnknownFixtures(fixtures, environment), agentRuntime };
}

/**
 * How long a core fixture lives: one test attempt, the worker, or, for
 * `engine`, as long as the state behind the engine's own fixtures, which the
 * engine declares (`isolation`).
 */
type CoreFixtureScope = 'test' | 'worker' | 'engine';

/** What a core fixture is built from: the attempt, and the parts its fixtures share. */
interface CoreFixtureContext {
  readonly environment: AttemptEnvironment;
  readonly engine: LocatorEngine;
  readonly screenContext: ScreenContext;
  readonly agentRuntime: AgentContext;
}

type CoreFixtureValues = AttemptFixtures['fixtures'];

/**
 * What the built-in fixtures of a target are read from: its name, its
 * platform, its engine's name, fixtures, and isolation, and the fixture
 * scopes of every target.
 */
export type BuiltInTarget = Pick<ResolvedTarget, 'name' | 'platform' | 'fixtureScopes'> & {
  readonly engine?: Pick<NonNullable<ResolvedTarget['engine']>, 'name' | 'isolation' | 'fixtures'> | undefined;
};

/** What a worker fixture is built from: the target and the worker's service values. */
type WorkerFixtureContext = {
  readonly target: Pick<BuiltInTarget, 'platform'>;
  readonly services: Readonly<Record<string, unknown>>;
};

/**
 * Definition for one core fixture: its scope and how it's built. Most
 * fixtures are built from an attempt (`create`). Fixtures built with
 * `ofWorker` depend only on the target and the worker's service values, so
 * they don't need an attempt and can be read by code that outlives attempts.
 */
type CoreFixture<Value> = { readonly scope: CoreFixtureScope } & (
  | { create(context: CoreFixtureContext): Value }
  | { ofWorker(worker: WorkerFixtureContext): Value }
);

/**
 * The fixtures every attempt has, whatever its engine: each one's name, its
 * scope, and how it is built. `createFixtures` builds them through this
 * table, beside the engine's own (`Engine.fixtures`); everything else reads
 * it through `builtInFixtures`.
 */
export const CORE_FIXTURES: { readonly [Name in keyof CoreFixtureValues]: CoreFixture<CoreFixtureValues[Name]> } = {
  agent: {
    scope: 'test',
    create({ agentRuntime }) {
      // The attempt's own agent is checked as the fixture is acquired.
      agentRuntime.select(undefined);
      return createAgentFixture(agentRuntime);
    },
  },
  app: { scope: 'engine', create: ({ environment, engine }) => createApp(environment, engine) },
  screen: { scope: 'engine', create: ({ screenContext }) => createScreen(screenContext) },
  platform: { scope: 'worker', ofWorker: ({ target }) => target.platform },
  request: { scope: 'test', create: ({ environment, engine }) => createRequest({ environment, actionTimeout: () => engine.actionTimeout }) },
  services: { scope: 'worker', ofWorker: ({ services }) => services },
  session: {
    scope: 'test',
    create: ({ environment }) => ({
      save: async (name: string) => {
        const saveSession = environment.saveSession;
        if (saveSession === undefined) {
          throw new ConfigurationError(
            'INVALID_CONFIG',
            'session.save() is only available inside setup tests',
          );
        }
        await environment.steps.run('session', 'session.save', name, () => saveSession(name));
      },
    }),
  },
};

/** The table by any name: `CORE_FIXTURES` typed for a lookup that may miss. */
const CORE_FIXTURE: Readonly<Record<string, CoreFixture<unknown> | undefined>> = CORE_FIXTURES;

/** The table's entry for `name`, when it is a core fixture. */
function coreFixture(name: string): CoreFixture<unknown> | undefined {
  return Object.hasOwn(CORE_FIXTURE, name) ? CORE_FIXTURE[name] : undefined;
}

/** Returns true when reading `name` requires an attempt, which is every fixture except core fixtures derived from the target or worker. */
function needsAttempt(name: string): boolean {
  const fixture = coreFixture(name);
  return fixture === undefined || !('ofWorker' in fixture);
}

/**
 * The built-in fixtures of a target: the core ones and the ones its engine
 * contributes. The one place that knows their names, their scopes, and which
 * of them need an attempt.
 */
export interface BuiltInFixtures {
  /** The target the fixtures are of, for an error to name; undefined before one is known. */
  readonly targetName: string | undefined;
  /** Every built-in fixture name: the core ones, the engine's, then the ones only other targets have. */
  readonly names: readonly string[];
  /**
   * How long `name` lives: one test attempt or the worker. The engine's own
   * fixtures, `app`, and `screen` live as long as the state behind them,
   * which the engine declares (`isolation`), so before a target is known
   * they are `unresolved`, as is any name an engine might contribute.
   * A fixture only other targets have takes its scope from them.
   * Undefined when no target has a built-in fixture of that name.
   */
  scope(name: string): FixtureScope | 'unresolved' | undefined;
  /** Returns true when reading `name` requires an engine attempt, which is every built-in except those derived from the target or worker. */
  needsAttempt(name: string): boolean;
  /** The value of a built-in that needs no attempt. */
  attemptless(name: string): unknown;
  /** Why the target has no fixture `name`, beside the fixtures `available` to the code that asked. */
  missing(name: string, available: readonly string[]): string;
}

/** Returns the built-in fixtures for `target` with the worker's `services` values. */
export function builtInFixtures(target: BuiltInTarget, services: Readonly<Record<string, unknown>> = {}): BuiltInFixtures {
  const contributed = Object.keys(target.engine?.fixtures ?? {});
  const engineScope: FixtureScope = target.engine?.isolation === 'worker' ? 'worker' : 'test';
  return {
    targetName: target.name,
    names: [...new Set([...Object.keys(CORE_FIXTURES), ...contributed, ...target.fixtureScopes.keys()])],
    scope(name) {
      const scope = coreFixture(name)?.scope ?? (contributed.includes(name) ? 'engine' : target.fixtureScopes.get(name));
      return scope === 'engine' ? engineScope : scope;
    },
    needsAttempt: (name) => (contributed.includes(name) || !target.fixtureScopes.has(name)) && needsAttempt(name),
    attemptless(name) {
      const fixture = coreFixture(name);
      return fixture !== undefined && 'ofWorker' in fixture ? fixture.ofWorker({ target, services }) : undefined;
    },
    missing: (name, available) => unknownFixtureMessage(target, name, available),
  };
}

/**
 * The built-in fixtures as a `test.extend()` call can know them, before any
 * target is: the core ones whose scope no engine changes. Every other name
 * is `unresolved`, since an engine may contribute it, so none is missing.
 */
export const DECLARED_BUILT_INS: Omit<BuiltInFixtures, 'attemptless'> = {
  targetName: undefined,
  names: Object.keys(CORE_FIXTURES),
  scope(name) {
    const scope = coreFixture(name)?.scope ?? 'engine';
    return scope === 'engine' ? 'unresolved' : scope;
  },
  needsAttempt,
  missing: (name) => `no fixture is called "${name}"`,
};

/** Keys a test body may probe without meaning a fixture. */
const PROBED_KEYS = new Set(['then', 'constructor', 'toJSON', 'toString', 'valueOf', 'inspect']);

/** Fixtures other runners hand out, each pointed at the e2e way of doing the same thing. */
const FOREIGN_FIXTURE_HINTS: Readonly<Record<string, string>> = {
  page: 'there is no Playwright page: open the app with app.open() and find elements through screen; browser-only APIs are on the browser fixture of a Playwright target',
  context: 'the browser context is owned by the engine: cookies, routes, and storage are on the browser fixture of a Playwright target',
  driver: 'there is no WebDriver session: drive the device through app, screen, and (on an agent-device target) device',
};

/**
 * Why `target` has no fixture called `property`: the fixtures it does have
 * (`available`), what its engine contributes, and either the nearest name or,
 * for a fixture another runner hands out, the e2e way of doing the same thing.
 */
function unknownFixtureMessage(target: BuiltInTarget, property: string, available: readonly string[]): string {
  const declared = Object.keys(target.engine?.fixtures ?? {});
  const contributed = `engine ${target.engine?.name ?? 'none'} contributes ${declared.length === 0 ? 'no fixtures' : declared.join(', ')}`;
  const foreign = FOREIGN_FIXTURE_HINTS[property];
  const hint = foreign === undefined ? didYouMean(property, available) : `; ${foreign}`;
  return `target "${target.name}" has no "${property}" fixture; available: ${available.join(', ')} (${contributed})${hint}`;
}

/**
 * Reaching for a fixture that isn't on any target in the config fails at the
 * first touch with the earliest honest error: the engine's name and what it
 * does declare, instead of a TypeError three lines later.
 */
function gateUnknownFixtures<T extends object>(fixtures: T, environment: AttemptEnvironment): T {
  const { fixtureScopes } = environment.target;
  return new Proxy(fixtures, {
    get(target, property, receiver) {
      if (typeof property !== 'string' || property in target || PROBED_KEYS.has(property) || fixtureScopes.has(property)) {
        return Reflect.get(target, property, receiver) as unknown;
      }
      throw new ConfigurationError(
        'UNSUPPORTED_CAPABILITY',
        unknownFixtureMessage(environment.target, property, Object.keys(target).toSorted()),
      );
    },
  });
}

/**
 * Engine-contributed fixtures, as factories: an engine's factory declares
 * operation metadata through context.fixture and must return the surface it
 * declared. Each instance belongs to one test's fixture graph; the session's
 * ledger outlives that graph.
 */
function contributedFactories(
  environment: AttemptEnvironment,
  engine: LocatorEngine,
  screenContext: ScreenContext,
): Record<string, () => unknown> {
  const declared = environment.target.engine?.fixtures;
  if (declared === undefined) return {};
  const recorder = new FixtureRecorder(environment, () => engine.actionTimeout);
  const context = fixtureContext(environment, engine, screenContext, recorder);
  return Object.fromEntries(
    Object.entries(declared).map(([name, factory]) => [name, () => recorder.require(name, factory(context))]),
  );
}

function fixtureContext(
  environment: AttemptEnvironment,
  engine: LocatorEngine,
  screenContext: ScreenContext,
  recorder: FixtureRecorder,
): EngineFixtureContext {
  const { config, steps } = environment;
  const { app } = environment.target;
  return {
    targetName: environment.target.name,
    fixture: (name, surface, operations) => recorder.fixture(name, surface, operations),
    app: {
      ...engineAppInfo(app),
      resolveUrl: (url) => {
        requireAppUrl(environment.target);
        return resolveNavigationUrl(url, app.base).url;
      },
    },
    // Getters: an `@e2e-dev/core` session's `setDefaultTimeout` moves them under a live fixture.
    timeouts: {
      test: config.timeout,
      get action() {
        return engine.actionTimeout;
      },
      get assertion() {
        return engine.assertionTimeout;
      },
    },
    // A getter, not a snapshot: the SPI promises the running phase's signal.
    get signal() {
      return engine.signal;
    },
    operation: (timeoutMs) => engine.operation(timeoutMs),
    attachArtifact: (kind, relativePath) =>
      steps.attachArtifact(environment.artifacts.register(kind, relativePath)),
    attachViewport: (viewport) => steps.attachViewport(viewport),
    locator: (expression) => createLocator(screenContext, expression),
    screen: (wrap) => createScopedScreen(screenContext, wrap),
    expectable<T extends object, E extends object>(target: T, factory: () => E): T & Expectable<E> {
      let surface: E | undefined;
      Object.defineProperty(target, expectationBrand, {
        enumerable: false,
        configurable: true,
        get: () => {
          surface ??= recorder.require('expect', factory());
          return surface;
        },
      });
      return target as T & Expectable<E>;
    },
  };
}

/**
 * The built-in agent, built from the entry's `system` and `tools`, behind a
 * dynamic import, so the agent's loop loads only if an `agent.act()` step
 * actually runs. Deterministic suites and custom-executor projects never pay
 * for it.
 */
export function lazyBuiltInAgent(config: ResolvedAgentConfig): StepExecutor {
  let executor: StepExecutor | undefined;
  return {
    // Cache provenance and model policyVersion record this wrapper, not the
    // delegate it constructs, so both carry the one identity.
    ...BUILT_IN_AGENT,
    vision: true,
    async runStep(context) {
      if (executor === undefined) {
        const { createBuiltInAgent } = await import('../agent/default-agent.ts');
        executor = createBuiltInAgent({ system: config.system, tools: config.tools });
      }
      return executor.runStep(context);
    },
  };
}

/** Trusted config context first, then test/group context. */
function joinAgentContext(
  configContext: string | undefined,
  testContext: string | undefined,
): string | undefined {
  const parts = [configContext, testContext].filter(
    (part): part is string => part !== undefined && part.trim() !== '',
  );
  return parts.length === 0 ? undefined : parts.join('\n');
}

/** Navigation needs an app URL: the target's `app.url`. */
function requireAppUrl(target: ResolvedTarget): asserts target is ResolvedTarget & {
  app: { base: NonNullable<ResolvedTarget['app']['base']> };
} {
  if (target.app.base !== undefined) return;
  throw new ConfigurationError(
    'APP_URL_REQUIRED',
    `navigation needs an app URL: target "${target.name}" declares none; set app.url on the target`,
  );
}

/**
 * Network-level failures a browser or device reports when nothing is
 * listening where the app should be. Anything else that fails a navigation
 * (a certificate, a 500, a crash mid-load) stays an engine failure.
 */
const NOTHING_LISTENING =
  /ERR_CONNECTION_REFUSED|ECONNREFUSED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|ERR_ADDRESS_UNREACHABLE|EHOSTUNREACH|ERR_CONNECTION_TIMED_OUT|ETIMEDOUT/;

/**
 * Adds a recovery hint to navigation connection errors using the target's
 * command configuration. A `reuseExisting` command may have attached to a
 * process the runner did not start, whose output `app.command.log` never
 * holds, so its hint does not promise that output.
 */
function unreachableApp(cause: unknown, url: string, command: CommandConfig | undefined): InfrastructureError | undefined {
  const match = NOTHING_LISTENING.exec(errorMessage(cause));
  if (match === null) return undefined;
  const hint =
    command === undefined
      ? "start the app there, point the target's app.url at where it runs, or give the target an app.command so the runner starts it"
      : command.reuseExisting === true
        ? "check that the process serving the target's app.url still runs. With reuseExisting the runner may use a process it did not start, and app.command.log captures only a command the runner started"
        : "check the target's app.command output and app.url. Set app.command.log if output is not captured";
  return new InfrastructureError(
    'APP_UNREACHABLE',
    `nothing answered at ${url} (${match[0]}); ${hint}`,
    { cause },
  );
}

/** Builds the portable app fixture with the session's shared screenshot policy. */
export function createApp(
  environment: Pick<AttemptEnvironment, 'config' | 'steps' | 'target' | 'session' | 'artifacts'>,
  engine: LocatorEngine,
): App {
  const { config, steps, target } = environment;
  const recordings = sessionRecordings(environment.session, target.name);
  /** What bounds an open, a restart, or a link open: the default a program set, else the test's timeout. */
  const lifecycleMs = (): number => engine.lifecycleTimeout ?? config.timeout;

  /** Opens one resolved URL; a refused connection is reported as the app being down. */
  const openAt = async (resolved: string, timeoutMs: number): Promise<void> => {
    try {
      await engine.session.app.open(resolved, engine.operation(timeoutMs));
    } catch (cause) {
      throw unreachableApp(cause, resolved, target.app.command) ?? cause;
    }
  };

  /** One recorded navigation: resolved against the base URL, on the test budget. */
  const navigate = (api: string, label: string, url: string | undefined): Promise<void> =>
    steps.run('app', api, label, async () => {
      requireAppUrl(target);
      // The base goes through the rule too: a file app's file may have become a directory since the config loaded.
      const resolved = resolveNavigationUrl(url ?? target.app.base.href, target.app.base).url;
      await openAt(resolved, lifecycleMs());
    });

  /**
   * A steering hook ends at a fresh surface showing nothing, so the app is
   * reopened at its base URL through the same path as `app.open()`, and an
   * unreachable app after a restart is reported exactly as on first open.
   * The hook and the reopen share one budget, `lifecycleMs`. A target
   * without an address, or whose engine cannot open one (a device relaunches
   * its pinned app inside the hook), has nothing to reopen.
   */
  const steer = (api: string, hook: (operation: OperationContext) => Promise<void>): Promise<void> =>
    steps.run('app', api, '', async () => {
      const deadline = new Deadline(lifecycleMs());
      await hook(engine.operation(deadline.remaining()));
      if (target.app.base === undefined || !engine.session.verbs.has('navigate')) return;
      await openAt(resolveNavigationUrl(target.app.base.href, target.app.base).url, deadline.remaining());
    });

  /**
   * `app.open()` on a target with no URL and no `navigate`, a device: it
   * launches the pinned app fresh, the way Maestro's `launchApp` does, and is
   * what a test calls before it looks at the screen. A path has nowhere to
   * go there; a link goes through `device.openLink`. An engine without a
   * relaunch hook is refused here; one with a hook reports its own reason it
   * cannot launch, such as a build not installed yet.
   */
  const launchPinnedApp = (openPath: string | undefined): Promise<void> =>
    steps.run('app', 'app.open', openPath ?? '', async () => {
      const { linkBase } = target.app;
      if (openPath !== undefined && linkBase !== undefined) {
        const link = joinLink(linkBase, openPath);
        if (refusesLink(link)) throw new ConfigurationError('POLICY_DENIED', `app.open() refuses the link's scheme on target "${target.name}"`);
        await engine.session.app.openLink(link, engine.operation(lifecycleMs()));
        return;
      }
      if (openPath !== undefined) {
        throw new ConfigurationError(
          'APP_URL_REQUIRED',
          `app.open("${openPath}") needs an app URL and target "${target.name}" has none: on a device app.open() launches the pinned app; declare app.linkBase to open a path as a link in it, or open one through device.openLink`,
        );
      }
      if (target.engine?.session?.restart === undefined) {
        throw new ConfigurationError(
          'UNSUPPORTED_CAPABILITY',
          `app.open() has nothing to open on target "${target.name}": it has no app URL, and engine ${target.engine?.name ?? 'none'} does not relaunch a pinned app`,
        );
      }
      await engine.session.app.restart(engine.operation(lifecycleMs()));
    });

  return {
    baseUrl: target.app.base === undefined ? undefined : baseUrlOf(target.app.base),
    open: (openPath?: string) =>
      target.app.base === undefined && !engine.session.verbs.has('navigate')
        ? launchPinnedApp(openPath)
        : navigate('app.open', openPath ?? '/', openPath),
    restart: () => steer('app.restart', (operation) => engine.session.app.restart(operation)),
    clearState: () => steer('app.clearState', (operation) => engine.session.app.reset(operation)),
    async back(): Promise<void> {
      await steps.run('app', 'app.back', '', async () => {
        await engine.session.app.back(engine.operation());
      });
    },
    async screenshot(label?: string): Promise<string> {
      return steps.run('app', 'app.screenshot', label ?? '', async () => {
        const relative = await engine.session.artifacts.screenshot(label, engine.operation());
        environment.steps.attachArtifact(environment.artifacts.register('screenshot', relative));
        return path.join(environment.artifacts.dir, relative);
      });
    },
    async startRecording(options?: RecordingOptions): Promise<void> {
      const name = options?.name;
      await steps.run('app', 'app.startRecording', typeof name === 'string' ? name : '', async () => {
        await recordings.startSpan(name, engine.operation());
      });
    },
    stopRecording: () =>
      steps.run('app', 'app.stopRecording', '', async () => {
        const { ids, videos } = await recordings.stopSpan(engine.operation(), environment.artifacts);
        for (const id of ids) environment.steps.attachArtifact(id);
        return videos;
      }),
  };
}

/** Builds a value on first read and keeps it. */
export function lazily<T>(build: () => T): () => T {
  let built: { value: T } | undefined;
  return () => (built ??= { value: build() }).value;
}
