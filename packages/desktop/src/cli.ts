/**
 * One agent-desktop command per process, its JSON envelope read off stdout,
 * and its failure translated onto the engine error contract.
 *
 * | agent-desktop result                                          | Code                      |
 * | ------------------------------------------------------------- | ------------------------- |
 * | `STALE_REF`, `SNAPSHOT_NOT_FOUND`, `ELEMENT_NOT_FOUND`, sent nothing | NODE_STALE (retryable) |
 * | `APP_UNRESPONSIVE` that `details.retryable` says is safe to retry | NODE_STALE (retryable) |
 * | `ACTION_NOT_SUPPORTED`, `PLATFORM_NOT_SUPPORTED`, `POLICY_DENIED` | UNSUPPORTED_CAPABILITY |
 * | `APP_NOT_FOUND`, `WINDOW_NOT_FOUND`                           | INVALID_STATE             |
 * | `AMBIGUOUS_TARGET`, `ACTION_FAILED`, `TIMEOUT`, sent nothing  | NOT_ACTIONABLE            |
 * | `TIMEOUT` of a read                                           | OPERATION_TIMEOUT         |
 * | any failure of an input that may have been delivered          | ACTION_MAY_HAVE_COMMITTED |
 * | an input still running when the operation's budget ran out    | ACTION_MAY_HAVE_COMMITTED |
 * | an input whose process exited without printing a result       | ACTION_MAY_HAVE_COMMITTED |
 * | a read still running when the operation's budget ran out      | OPERATION_TIMEOUT         |
 * | the operation's signal aborted                                | CANCELLED                 |
 * | anything else, `PERM_DENIED` included                         | ENGINE_FAILURE            |
 *
 * agent-desktop states delivery on every failure (`disposition.delivery`),
 * so the line between "refused" and "may have committed" is its own, never a
 * guess from the error code.
 *
 * Text an action types reaches the process on stdin, never in its arguments,
 * which any process on the machine can read; no error here quotes stdin.
 */

import { spawn } from 'node:child_process';
import { EngineError } from '@e2e-dev/core/engine';

/** How agent-desktop says whether a command reached the app. */
interface Disposition {
  readonly delivery?: string;
  readonly retry?: string;
}

/** The `error` of a failed envelope. */
interface Failure {
  readonly code: string;
  readonly message: string;
  readonly disposition?: Disposition;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** One command's JSON envelope. */
interface Envelope {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: Failure;
}

/** One command to run. */
export interface CliCall {
  /** Arguments after the executable; never a value a test typed. */
  readonly args: readonly string[];
  /** Text written to the command's stdin, for `--stdin`. */
  readonly stdin?: string;
  /** Whether the command sends input to an app; decides how a cut-off or failed command is reported. */
  readonly input: boolean;
  /** Ends the command when it aborts. */
  readonly signal: AbortSignal;
  /** The command is killed once this budget is spent. */
  readonly timeoutMs: number;
  /** Names the command in an error message. */
  readonly label: string;
  /** The command's `TMPDIR`, in place of the run's: where it writes files of its own that a killed process leaves behind. */
  readonly tmpdir?: string;
}

/** A failure agent-desktop reported, before translation, for a caller that tries another way when nothing was sent. */
export class AgentDesktopFailure extends Error {
  readonly code: string;
  /** Whether agent-desktop says nothing reached the app, so another way may be tried. */
  readonly notDelivered: boolean;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(failure: Failure) {
    super(failure.message);
    this.name = 'AgentDesktopFailure';
    this.code = failure.code;
    this.notDelivered = failure.disposition?.delivery === 'not_delivered';
    this.details = failure.details ?? {};
  }
}

/** The least time an input gets once started, however little budget was left: a click that lands is then not reported as cut off. A read gets exactly its budget. */
const MIN_INPUT_MS = 500;

/** Runs agent-desktop commands for one worker: its executable, its private state directory. */
export class AgentDesktopCli {
  constructor(
    private readonly executable: string,
    private readonly env: Readonly<Record<string, string | undefined>>,
  ) {}

  /**
   * Runs one command and returns its `data`. A failure the envelope reports
   * is thrown as `AgentDesktopFailure`, untranslated, so a caller can try
   * another way when nothing was sent; `translate` turns it into the engine
   * contract.
   */
  async run<T>(call: CliCall): Promise<T> {
    if (call.signal.aborted) throw new EngineError('CANCELLED', `${call.label} was cancelled`, { retryable: false });
    const { stdout, stderr, cutOff } = await this.spawn(call);
    if (cutOff === 'aborted') throw new EngineError('CANCELLED', `${call.label} was cancelled`, { retryable: false });
    if (cutOff === 'timeout') {
      throw call.input
        ? new EngineError('ACTION_MAY_HAVE_COMMITTED', `${call.label} timed out before agent-desktop answered; its input may have reached the app`, { retryable: false })
        : new EngineError('OPERATION_TIMEOUT', `${call.label} timed out`, { retryable: false });
    }
    const envelope = parseEnvelope(stdout);
    // A process that started and printed no result may have sent its input before it died.
    if (envelope === undefined && call.input) {
      throw new EngineError('ACTION_MAY_HAVE_COMMITTED', `${call.label}: agent-desktop exited without a result; its input may have reached the app`, { retryable: false });
    }
    if (envelope === undefined) {
      const detail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500);
      throw new EngineError('ENGINE_FAILURE', `${call.label}: agent-desktop printed no result${detail === '' ? '' : ` (${detail})`}`, { retryable: false });
    }
    if (!envelope.ok) throw new AgentDesktopFailure(envelope.error ?? { code: 'INTERNAL', message: 'agent-desktop failed without an error' });
    return envelope.data as T;
  }

  /** One process, killed when the call's signal aborts or its budget runs out. */
  private spawn(call: CliCall): Promise<{ stdout: string; stderr: string; cutOff?: 'aborted' | 'timeout' }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, call.args, {
        env: call.tmpdir === undefined ? this.env : { ...this.env, TMPDIR: call.tmpdir },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let cutOff: 'aborted' | 'timeout' | undefined;
      const stop = (reason: 'aborted' | 'timeout'): void => {
        cutOff ??= reason;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => stop('timeout'), call.input ? Math.max(call.timeoutMs, MIN_INPUT_MS) : call.timeoutMs);
      const onAbort = (): void => stop('aborted');
      call.signal.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      // A command that exits before reading its stdin closes the pipe; the write error is that, not a failure.
      child.stdin.on('error', () => undefined);
      child.stdin.end(call.stdin ?? '');
      child.on('error', (cause) => {
        clearTimeout(timer);
        call.signal.removeEventListener('abort', onAbort);
        reject(new EngineError('ENGINE_FAILURE', `${call.label}: could not start agent-desktop at ${this.executable}: ${cause.message}`, { retryable: false, cause }));
      });
      child.on('close', () => {
        clearTimeout(timer);
        call.signal.removeEventListener('abort', onAbort);
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          ...(cutOff === undefined ? {} : { cutOff }),
        });
      });
    });
  }
}

/** The envelope agent-desktop printed: the last line of stdout that parses as one. */
function parseEnvelope(stdout: string): Envelope | undefined {
  const lines = stdout.trim().split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { ok?: unknown }).ok === 'boolean') return parsed as Envelope;
    } catch {
      // Not the envelope; keep looking.
    }
  }
  return undefined;
}

const STALE_CODES = new Set(['STALE_REF', 'SNAPSHOT_NOT_FOUND', 'ELEMENT_NOT_FOUND']);
const UNSUPPORTED_CODES = new Set(['ACTION_NOT_SUPPORTED', 'PLATFORM_NOT_SUPPORTED', 'POLICY_DENIED']);
const GONE_CODES = new Set(['APP_NOT_FOUND', 'WINDOW_NOT_FOUND']);
const REFUSED_CODES = new Set(['AMBIGUOUS_TARGET', 'ACTION_FAILED', 'TIMEOUT']);

/**
 * The engine error for a failure of `label`. An `EngineError` passes through.
 * `input` says whether the command sent input to the app: its failure is
 * `ACTION_MAY_HAVE_COMMITTED` unless agent-desktop says nothing was sent.
 */
export function translate(cause: unknown, label: string, input: boolean): Error {
  if (!(cause instanceof AgentDesktopFailure)) return cause instanceof Error ? cause : new EngineError('ENGINE_FAILURE', `${label}: ${String(cause)}`, { retryable: false });
  const text = `${label}: ${cause.message}`;
  if (input && !cause.notDelivered) return new EngineError('ACTION_MAY_HAVE_COMMITTED', `${text} (the input may have reached the app)`, { retryable: false, cause });
  if (STALE_CODES.has(cause.code)) return new EngineError('NODE_STALE', text, { retryable: true, cause });
  // A read agent-desktop says is safe to try again (the window list changed while it read): read again, as a stale one.
  if (cause.code === 'APP_UNRESPONSIVE' && cause.details.retryable === true) return new EngineError('NODE_STALE', text, { retryable: true, cause });
  if (UNSUPPORTED_CODES.has(cause.code)) return new EngineError('UNSUPPORTED_CAPABILITY', text, { retryable: false, cause });
  if (GONE_CODES.has(cause.code)) return new EngineError('INVALID_STATE', `${text}; open the app with app.open()`, { retryable: false, cause });
  // A read that ran out of time is a timeout; only an input that could not be delivered in time is not actionable.
  if (cause.code === 'TIMEOUT' && !input) return new EngineError('OPERATION_TIMEOUT', text, { retryable: false, cause });
  if (REFUSED_CODES.has(cause.code)) return new EngineError('NOT_ACTIONABLE', text, { retryable: false, cause });
  if (cause.code === 'PERM_DENIED') {
    return new EngineError('ENGINE_FAILURE', `${text}. Grant Accessibility (and Screen Recording, for screenshots) to the app that starts e2e, such as your terminal, then run again`, { retryable: false, cause });
  }
  return new EngineError('ENGINE_FAILURE', text, { retryable: false, cause });
}
