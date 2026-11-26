/**
 * `e2e run --step` without a terminal, for a coding agent or a script. The
 * run goes on in a process of its own, and later commands from the same
 * directory drive it: `e2e run --step next`, `rest`, and `stop`. Each command
 * returns once the run holds its next step or ends, with what the run printed
 * since the last command, how each step that ran since then ended, and the
 * held step with the screen it waits on, or a line saying the run has ended.
 *
 * The background run listens on a Unix socket (a named pipe on Windows) in a
 * directory only this user can open, keyed by the working directory, so one
 * directory has one stepped run at a time. A run without `--step` starts
 * listening on the same socket at its first `screen.pause()`. The commands
 * can then resume the test. An MCP client connects to the same socket to
 * drive the app while the test waits.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import picocolors from 'picocolors';
import { z } from 'zod';
import { classifyError, codedMessage, ConfigurationError, errorMessage, exitCodeForCategory } from '@e2e-dev/core/lib/internal/errors';
import { bounded } from '../report/format.ts';
import { printsAtEnd } from '../report/list-model.ts';
import { stepLine, stepPromptText } from '../report/list-steps.ts';
import type { RunEventSink } from '../run/events.ts';
import { writeTerminal } from '../run/process-output.ts';
import { run, type RunOptions, type RunOutcome } from '../run/runner.ts';
import type { OutputStream, RunnerOutput } from '../run/process-output.ts';
import type { BeforeStep, HeldStep, StepHoldContext, StepPrompt } from '../run/step-hold.ts';
import {
  ATTACH_PROTOCOL,
  AttachHello,
  type AttachReply,
  AttachRequest,
  type HeldTestAttachment,
  NO_HELD_TEST,
} from '../run/step-attachment-wire.ts';
import { parseLine, readSocketLines, stepAddress, type StepAddress } from '../run/step-socket.ts';
import type { Keyboard } from './keyboard.ts';
import type { SignalLadder } from './signals.ts';
import { STEP_ACTIONS, StepGate, type StepAction } from './step.ts';
import { StepKeyboard } from './step-viewer.ts';

/**
 * What a command sends, and what the background run answers: the text the
 * command prints and the exit code it ends with. The starting command names
 * its run's log, so it never drives a run another command started.
 */
const StepRequest = z.object({ action: z.enum(STEP_ACTIONS), log: z.string().optional() });
const StepReply = z.object({ text: z.string(), exitCode: z.number() });
type StepReply = z.infer<typeof StepReply>;

/** A held step that hasn't been shown to a command yet. */
type UnseenPrompt = {
  readonly prompt: StepPrompt;
  readonly readScreen: StepHoldContext['readScreen'];
};

type PauseKeyboardOptions = {
  readonly holdSteps?: boolean;
  readonly interrupt?: () => void;
};

/** How long a stepped run holds a step with no command acting on it before it stops, and keeps its end for a command after it ended with none waiting. */
const IDLE_STOP_MS = 30 * 60_000;
/** How long an answer waits for more steps of the same `Promise.all` to be held beside the first. */
const JOIN_MS = 100;
/** A claim lock older than this was left by a run killed while it claimed, which takes milliseconds. */
const STALE_LOCK_MS = 10_000;
/** How often the starting command looks for the background run's socket while it boots. */
const CONNECT_POLL_MS = 100;
/** How long the run waits, once it has ended, for its last answers to reach their commands. */
const FLUSH_MS = 5_000;
/** The last line of the answer to a command the run ended on, so a reader knows no command is left to send. */
const ENDED = 'The stepped run has ended.\n';
/** The last line of a command's answer when a run without `--step` ends. */
const RUN_ENDED = 'The run has ended.\n';
/** Why a second start is refused; a word that is not an action reads as a file and lands here too. */
const ALREADY_GOING = 'another run in this directory is already controlled with e2e run --step: continue it with e2e run --step next or rest, or end it with e2e run --step stop';
/** The error for a pause without a terminal when another run owns the socket. */
const ALREADY_GOING_AT_PAUSE = 'another run in this directory is already controlled with e2e run --step; end it with e2e run --step stop, or run this test in a terminal';

/**
 * Sends one request and reads the answer. `absent` when nothing listens;
 * `closed` when the run hung up without answering.
 */
function ask(socket: string, request: z.infer<typeof StepRequest>): Promise<StepReply | 'absent' | 'closed'> {
  return new Promise((resolve) => {
    let received = '';
    let connected = false;
    const connection = net.connect(socket, () => {
      connected = true;
      connection.write(`${JSON.stringify(request)}\n`);
    });
    connection.setEncoding('utf8');
    connection.on('data', (chunk: string) => {
      received += chunk;
    });
    connection.on('error', () => undefined);
    connection.on('close', () => {
      if (!connected) {
        resolve('absent');
        return;
      }
      resolve(parseLine(received, StepReply) ?? 'closed');
    });
  });
}

/** Whether a stepped run listens on `socket`; connects and hangs up without asking anything. */
function listening(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const connection = net.connect(socket, () => {
      connection.end();
      resolve(true);
    });
    connection.on('error', () => resolve(false));
  });
}

/** Removes a socket file. Named pipes leave nothing behind. */
function removeSocket(socket: string): void {
  if (process.platform !== 'win32') fs.rmSync(socket, { force: true });
}

/** Reads what the log gained since `offset`. */
function readSince(file: string, offset: number): { readonly text: string; readonly offset: number } {
  try {
    const all = fs.readFileSync(file);
    return { text: all.subarray(offset).toString('utf8'), offset: Math.max(offset, all.length) };
  } catch {
    return { text: '', offset };
  }
}

/**
 * The starting command: spawns the stepped run in a process of its own and
 * returns once it holds its first step or ends. Throws when a stepped run
 * already listens for this directory.
 */
export async function startStepped(address: StepAddress, args: readonly string[]): Promise<number> {
  if (await listening(address.socket)) {
    throw new ConfigurationError('RUNNER_BUSY', ALREADY_GOING);
  }
  // Before a `--`, which ends the options.
  const end = args.includes('--') ? args.indexOf('--') : args.length;
  const serveArgs = [...args.slice(0, end), '--step-serve', address.log, ...args.slice(end)];
  const log = fs.openSync(address.log, 'w', 0o600);
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, ...serveArgs], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  fs.closeSync(log);
  const exited = new Promise<number>((resolve) => {
    child.once('exit', (code) => resolve(code ?? 1));
    child.once('error', () => resolve(2));
  });
  process.stdout.write('No terminal, so the run goes on in the background. Drive it from this directory with e2e run --step next, rest, or stop.\n');
  for (;;) {
    // `next` runs no step a command has not printed, so this waits for the first held one.
    const answer = await ask(address.socket, { action: 'next', log: address.log });
    if (typeof answer === 'object') {
      child.unref();
      process.stdout.write(answer.text);
      return answer.exitCode;
    }
    const code = await Promise.race([exited, sleep(CONNECT_POLL_MS)]);
    if (code !== undefined) {
      // It ended before anyone asked (a config that would not load), and kept its log: what it printed says why.
      process.stdout.write(readSince(address.log, 0).text + ENDED);
      fs.rmSync(address.log, { force: true });
      return code;
    }
  }
}

/** A later command: sends `action` to the stepped run for this directory and prints its answer. */
export async function sendStep(address: StepAddress, action: StepAction): Promise<number> {
  const answer = await ask(address.socket, { action });
  if (answer === 'absent') throw new Error('no run in this directory can be controlled with e2e run --step: start one with e2e run <files> --step, or wait until a test is paused at screen.pause()');
  if (answer === 'closed') throw new Error('the run was killed before it answered; start it again');
  process.stdout.write(answer.text);
  return answer.exitCode;
}

/**
 * Listens on `address.socket`; a socket file a dead run left is removed, a
 * live run's is refused with `busyMessage`. The run holds `address.lock`, created exclusively,
 * while it claims, so two runs starting at once over a dead run's file cannot
 * both remove it and listen: the one without the lock is refused. A lock a
 * run killed mid-claim left is refused too, with its path to remove. Named pipes
 * go with their process, so a taken one is always live. When the process
 * exits while the server still listens (a forced exit, a host that ends
 * first), the socket file is removed on exit. Otherwise `server.close()`
 * removes it.
 */
async function claim(server: net.Server, address: StepAddress, busyMessage: string): Promise<void> {
  const busy = (cause: unknown): ConfigurationError =>
    new ConfigurationError('RUNNER_BUSY', busyMessage, { cause });
  const listen = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const onError = (cause: Error): void => {
        server.off('listening', onListening);
        reject(cause);
      };

      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(address.socket);
    });
  let held: number;
  try {
    held = fs.openSync(address.lock, 'wx', 0o600);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
    // Never removed here: two runs that both found it stale could both take it.
    const made = fs.statSync(address.lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now();
    if (Date.now() - made < STALE_LOCK_MS) throw busy(cause);
    throw new ConfigurationError('RUNNER_BUSY', `${address.lock} was left by a run killed while it took control of this directory; remove it and run again`, { cause });
  }
  try {
    await listen();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw cause;
    if (process.platform === 'win32' || (await listening(address.socket))) throw busy(cause);
    removeSocket(address.socket);
    await listen();
  } finally {
    fs.closeSync(held);
    fs.rmSync(address.lock, { force: true });
  }

  const removeOnExit = (): void => {
    if (server.listening) {
      removeSocket(address.socket);
    }
  };

  process.once('exit', removeOnExit);
  server.once('close', () => process.off('exit', removeOnExit));
}

/**
 * Answers every waiting command with its note followed by `reply`. The run
 * waits for each connection to close (`sent`) before it exits, since process
 * exit doesn't wait for sockets.
 */
function answerWaiting(waiting: Map<net.Socket, string>, reply: StepReply, sent: Promise<unknown>[]): void {
  for (const [client, note] of waiting) {
    sent.push(new Promise((resolve) => client.once('close', resolve)));
    client.end(`${JSON.stringify({ text: note + reply.text, exitCode: reply.exitCode } satisfies StepReply)}\n`);
  }
  waiting.clear();
}

type AttachmentSocketOptions = {
  readonly attach: () => StepHoldContext['attach'] | undefined;
  readonly onError: (cause: unknown) => void;
};

type CommandServerOptions = AttachmentSocketOptions & {
  readonly version: string;
  readonly step: (client: net.Socket, request: z.infer<typeof StepRequest>) => void;
};

/** Handles requests on one attachment connection. */
function attachmentConnection(client: net.Socket, options: AttachmentSocketOptions) {
  const connection = new AbortController();
  const calls = new Map<string, AbortController>();
  let attachRequested = false;
  let attachment: HeldTestAttachment | undefined;
  let detachRequested = false;

  /** Sends a reply while the connection is open for writes. */
  const write = (reply: AttachReply): void => {
    if (!client.destroyed && !client.writableEnded) {
      client.write(`${JSON.stringify(reply)}\n`);
    }
  };

  /** Sends the last reply before closing the socket. */
  const closeWithReply = (reply: AttachReply): void => {
    if (client.destroyed || client.writableEnded) {
      return;
    }

    client.end(`${JSON.stringify(reply)}\n`);
    client.destroySoon();
  };

  /** Notifies the client when the run ends its attachment. */
  const onAttachmentEnd = (): void => {
    if (attachment === undefined || detachRequested) {
      return;
    }

    detachRequested = true;
    write({
      type: 'ended',
      reason: errorMessage(attachment.signal.reason),
    });
    void attachment.detach().then(
      (text) => closeWithReply({ type: 'recording', text }),
      (cause: unknown) => {
        const { category, code, message } = classifyError(cause);

        closeWithReply({ type: 'error', category, code, message });
      },
    );
  };

  client.once('close', () => {
    connection.abort();
    attachment?.signal.removeEventListener('abort', onAttachmentEnd);

    if (!detachRequested) {
      void attachment?.detach().catch(options.onError);
    }
  });

  /** Gets the session for a request that requires an open attachment. */
  const requireAttachment = (): HeldTestAttachment => {
    if (attachment === undefined || detachRequested) {
      throw new ConfigurationError('NO_SESSION', "this connection doesn't have an open attachment");
    }

    return attachment;
  };

  /** Handles one request. Several calls may be pending on the connection. */
  const dispatch = async (request: AttachRequest): Promise<void> => {
    let requestIdToClear: string | undefined;

    try {
      switch (request.type) {
        case 'attach': {
          if (attachRequested) {
            throw new ConfigurationError('INVALID_ARGUMENT', 'this connection already requested an attachment');
          }

          attachRequested = true;
          const attach = options.attach();

          if (attach === undefined) {
            throw new ConfigurationError('NO_SESSION', NO_HELD_TEST);
          }

          const opened = await attach(request.id, connection.signal, request.sessionId);

          if (connection.signal.aborted || client.writableEnded) {
            await opened.detach();
            return;
          }

          attachment = opened;

          if (opened.signal.aborted) {
            onAttachmentEnd();
            return;
          }

          opened.signal.addEventListener('abort', onAttachmentEnd, { once: true });
          write({ type: 'opening', opening: opened.opening });
          return;
        }

        case 'detach': {
          if (detachRequested && attachment?.signal.aborted === true) {
            return;
          }

          const attached = requireAttachment();
          detachRequested = true;

          const recording = await attached.detach();
          closeWithReply({ type: 'detached', recording });
          return;
        }

        case 'cancel':
          calls.get(request.requestId)?.abort();
          return;

        case 'detail': {
          const attached = requireAttachment();
          const { requestId, name } = request;

          requestIdToClear = requestId;
          const text = await attached.detail(name);
          write({ type: 'detail', requestId, text });

          return;
        }

        case 'call': {
          const attached = requireAttachment();
          const { requestId, name, args } = request;
          const cancel = new AbortController();

          requestIdToClear = requestId;
          calls.set(requestId, cancel);
          const { errorCode, ...result } = await attached.call(name, args, cancel.signal);
          write({ type: 'result', requestId, result, errorCode });

          return;
        }
      }
    } catch (cause) {
      const { category, code, message } = classifyError(cause);

      if (request.type === 'call' || request.type === 'detail') {
        write({
          type: 'error',
          requestId: request.requestId,
          category,
          code,
          message,
        });
      } else {
        closeWithReply({ type: 'error', category, code, message });
      }
    } finally {
      if (requestIdToClear !== undefined) {
        calls.delete(requestIdToClear);
      }
    }
  };

  return {
    closeWithReply,
    /** Reads a request line. Returns false when the socket can't take another request. */
    read: (line: string): boolean => {
      if (client.writableEnded) {
        return false;
      }

      const request = parseLine(line, AttachRequest);

      if (request === undefined) {
        client.destroy();
        return false;
      }

      void dispatch(request);
      return !client.writableEnded;
    },
  };
}

/** Routes the first line to a step command or an attachment handshake. */
function commandServer(options: CommandServerOptions) {
  const connections = new Map<net.Socket, ReturnType<typeof attachmentConnection>['closeWithReply']>();
  let runEnded = false;

  const server = net.createServer((client) => {
    client.on('error', () => undefined);
    let receive: ((line: string) => boolean) | undefined;

    readSocketLines(client, (line) => {
      if (receive !== undefined) {
        return receive(line);
      }

      const hello = parseLine(line, AttachHello);

      if (hello !== undefined) {
        let error: Extract<AttachReply, { type: 'error' }> | undefined;

        if (hello.protocol !== ATTACH_PROTOCOL) {
          error = {
            type: 'error',
            category: 'configuration',
            code: 'UNSUPPORTED_CAPABILITY',
            message: 'attachment protocol mismatch between ' +
              `e2e mcp (e2e ${hello.version}) and e2e run (e2e ${options.version}). ` +
              'Run the same e2e version for e2e mcp and e2e run.',
          };
        } else if (runEnded) {
          error = {
            type: 'error',
            category: 'configuration',
            code: 'NO_SESSION',
            message: NO_HELD_TEST,
          };
        }

        if (error !== undefined) {
          client.end(`${JSON.stringify(error)}\n`);
          client.destroySoon();
          return false;
        }

        const connection = attachmentConnection(client, options);
        connections.set(client, connection.closeWithReply);
        client.once('close', () => connections.delete(client));

        const reply = {
          type: 'hello',
          protocol: ATTACH_PROTOCOL,
          version: options.version,
        } satisfies AttachReply;

        client.write(`${JSON.stringify(reply)}\n`);
        receive = connection.read;
        return true;
      }

      const request = parseLine(line, StepRequest);

      if (request === undefined) {
        client.destroy();
      } else {
        options.step(client, request);
      }

      return false;
    });
  });

  return {
    server,
    /** Closes attachments with a final reply so clients get a reason before the run exits. */
    endAttachments(sent: Promise<unknown>[]): void {
      runEnded = true;

      for (const [client, closeWithReply] of connections) {
        if (client.destroyed || client.writableEnded) {
          continue;
        }

        sent.push(new Promise((resolve) => client.once('close', resolve)));
        closeWithReply({ type: 'ended', reason: 'the run ended' });
      }
    },
  };
}

/**
 * The background run: runs the tests with every later step held, and
 * answers commands on `address.socket`. A command applies its action, then
 * gets its answer when the run holds a step no command has printed yet, or
 * ends: `next` and `rest` act only on a held step a command has printed, so
 * one whose command was killed is printed first, never run unseen. Each
 * answer starts with what the run's output (`address.log`) gained since the
 * last. The process ends once the run has and a command got the end, so a
 * command killed by its shell's timeout loses nothing; a run that ends
 * before any command got an answer keeps its log for the starting command.
 */
export async function serveSteps(options: RunOptions, version: string, signals: SignalLadder, address: StepAddress): Promise<RunOutcome> {
  /** The held step no command has printed yet. */
  let unseen: UnseenPrompt | undefined;
  let stopping = false;
  let ended: StepReply | undefined;
  let printed = 0;
  /** Whether a command got an answer, so the starting command no longer reads the log. */
  let answered = false;
  /** Whether a step a command printed waits for `next` or `rest`. */
  let held = false;
  /** Each waiting command, with the note its answer opens with when its action was not applied. */
  const waiting = new Map<net.Socket, string>();
  /** Answers on their way out, which the run waits for before it ends: its exit does not wait for sockets. */
  const sent: Promise<unknown>[] = [];
  let joining: NodeJS.Timeout | undefined;
  let idle: NodeJS.Timeout | undefined;
  /** Called once a command got the end. */
  let endSent: (() => void) | undefined;

  /** Each call climbs the ladder a rung, as a second `q` forces a run whose teardown hangs. */
  const stop = (): void => {
    stopping = true;
    signals.escalate();
  };
  const gate = new StepGate(stop, { keyboard: false });
  /** Sends `reply` and any new run output to every waiting command. */
  const send = (reply: StepReply): void => {
    answered = true;
    const since = readSince(address.log, printed);
    printed = since.offset;
    answerWaiting(waiting, { text: since.text + reply.text, exitCode: reply.exitCode }, sent);
  };
  /** Answers every waiting command, once there is a step no command has printed, or the end. */
  const answer = async (): Promise<void> => {
    if (waiting.size === 0) {
      return;
    }

    if (ended !== undefined) {
      send(ended);
      endSent?.();
      return;
    }

    const shown = unseen;

    if (shown === undefined || stopping) {
      return;
    }

    const screen = await shown.readScreen();

    // Discard the screen if the step ended or the run started stopping while
    // it was being read. A waiting command gets the next prompt or the end.
    if (unseen !== shown || ended !== undefined || stopping || waiting.size === 0) {
      return;
    }

    unseen = undefined;
    send({ text: stepPromptText(shown.prompt, screen), exitCode: 0 });
  };
  /** Answers a moment later, so the steps of one `Promise.all` held one after another share the answer. */
  const answerSoon = (): void => {
    clearTimeout(joining);
    joining = setTimeout(() => void answer(), JOIN_MS);
  };
  /**
   * Applies one command's action, and returns the note its answer opens with
   * when the action was not applied. `next` and `rest` act only on a held
   * step a command has printed.
   */
  const apply = (action: StepAction, starting: boolean): string => {
    // The run is over; the command gets its end.
    if (ended !== undefined) return action === 'stop' || starting ? '' : `e2e run --step ${action} was not applied: the run had ended.\n`;
    if (action === 'stop') stop();
    // The starting command waits for the first held step and presses nothing.
    else if (starting) return '';
    else if (unseen !== undefined) return `e2e run --step ${action} was not applied: the step below was held while no command waited, so it shows first.\n`;
    else if (!held) return `e2e run --step ${action} was not applied: it came while a step ran, so it waited for the next held step or the end; send it again to apply it.\n`;
    else gate.press(action === 'next' ? 'continue' : 'rest', { guard: false });
    return '';
  };
  /** A held step nobody acts on stops the run, so an abandoned one does not keep its app and browser. */
  const restartIdle = (): void => {
    clearTimeout(idle);
    if (held) idle = setTimeout(stop, IDLE_STOP_MS);
  };
  const handle = (client: net.Socket, { action, log }: z.infer<typeof StepRequest>): void => {
    // Another start's command, which waits for its own run to fail.
    if (log !== undefined && log !== address.log) {
      client.destroy();
      return;
    }
    waiting.set(client, apply(action, log !== undefined));
    restartIdle();
    client.on('close', () => waiting.delete(client));
    answerSoon();
  };

  let attach: StepHoldContext['attach'] | undefined;
  const { server, endAttachments } = commandServer({
    version,
    step: handle,
    attach: () => attach,
    onError: (cause) => process.stderr.write(`closing an attachment failed: ${codedMessage(cause)}\n`),
  });
  await claim(server, address, ALREADY_GOING);

  const beforeStep: BeforeStep = (step, context) => {
    attach = context.attach;
    return gate.beforeStep(step, {
      ...context,
      show: (shown) => {
        // The reporters learn of the wait; the commands answer it.
        context.show(shown);
        unseen = shown === undefined ? undefined : { prompt: shown, readScreen: context.readScreen };
        held = shown !== undefined;
        restartIdle();
        answerSoon();
      },
    });
  };
  const plain = picocolors.createColors(false);
  // Beside the list reporter's lines, not as the runner's own console output.
  const print = (line: string): void => writeTerminal('stdout', `${line}\n`);
  /**
   * Prints how each step ended into the run's output, which the next answer
   * starts with, then passes the event on. Agent steps are left out: without a
   * terminal the list reporter prints those itself.
   */
  const onEvent: RunEventSink = (event) => {
    if (event.type === 'step' && event.progress.phase === 'end' && !printsAtEnd(event.progress.kind)) {
      const { api, label, kind, status, durationMs, modelCalls, error, identity } = event.progress;
      print(stepLine(plain, { api, label, kind, actor: identity?.actor, outcome: { status, durationMs, modelCalls } }));
      if (error !== undefined) print(bounded(`${error.code}: ${error.message}`).replace(/^/gm, '  '));
    }
    return options.onEvent?.(event);
  };
  try {
    const outcome = await run({ ...options, hold: { ask: beforeStep, steps: true }, onEvent });
    ended = { text: ENDED, exitCode: outcome.exitCode };
    return outcome;
  } catch (cause) {
    ended = { text: `error: ${codedMessage(cause)}\n${ENDED}`, exitCode: exitCodeForCategory(classifyError(cause).category) };
    throw cause;
  } finally {
    clearTimeout(joining);
    clearTimeout(idle);
    endAttachments(sent);
    const sending = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, IDLE_STOP_MS);
      endSent = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    void answer();
    await sending;
    // Removes the socket file too, while this run still owns it.
    server.close();
    if (answered) fs.rmSync(address.log, { force: true });
    await Promise.race([Promise.all(sent), sleep(FLUSH_MS, undefined, { ref: false })]);
  }
}

/**
 * Runs tests with pauses at `screen.pause()` and at held steps in a
 * terminal `--step` run. Resume each pause or stop the run to continue.
 *
 * - In a terminal, `stdin` is read only while a pause is shown. Between
 *   pauses, the terminal is left as it was. Under `--watch`, `keys` is
 *   paused while a pause prompt is shown, so the keys reach the prompt.
 *   In a terminal stepped run, the keyboard stays active throughout.
 * - From the same directory, `e2e run --step next` and `rest` resume the
 *   shown test. `stop` stops the run, as `q` does. The command returns at
 *   the next pause or when the run ends.
 * - The run claims the directory's socket (`stepAddress`) at its first
 *   pause, so a run that never pauses leaves it free. It closes the socket
 *   when the run ends.
 * - Without a terminal, a pause fails with `RUNNER_BUSY` if another run has
 *   the socket. In a terminal, the keys still work. A printed line explains
 *   that commands reach the other run. Other claim errors are printed.
 * - Pauses from several workers are shown one at a time, oldest first. The
 *   other workers continue.
 * - Without a terminal, each pause is printed in the run's output. The run
 *   stops after 30 minutes at a pause with no command.
 */
export async function servePauses(
  options: RunOptions & { readonly processOutput: RunnerOutput },
  version: string,
  stop: () => void,
  stdin: NodeJS.ReadStream | undefined,
  keys?: Pick<Keyboard<unknown>, 'pause' | 'resume'>,
  { holdSteps: steps = false, interrupt = stop }: PauseKeyboardOptions = {},
): Promise<RunOutcome> {
  /** The first pause on the prompt currently shown. */
  let shown: HeldStep | undefined;
  /** Waiting commands and the note that precedes each answer. */
  const waiting = new Map<net.Socket, string>();
  /** Answers being sent. The run waits for their connections to close. */
  const sent: Promise<unknown>[] = [];
  let idle: NodeJS.Timeout | undefined;
  let claimed: Promise<void> | undefined;
  /** The run's final answer, returned right away to later commands. */
  let ended: StepReply | undefined;
  /** Reads keys while a pause prompt is shown in a terminal. */
  let keyboard: StepKeyboard | undefined;

  /** The terminal the viewer opens on. Never a stdout the run reserved, where the screen would land in front of the json report. */
  const stream = (): OutputStream | undefined => {
    if (process.stderr.isTTY === true) return 'stderr';
    return process.stdout.isTTY === true && !options.processOutput.stdoutReserved ? 'stdout' : undefined;
  };
  const gate = new StepGate(stop, { holdSteps: steps, viewer: () => stdin !== undefined && stream() !== undefined, keyboard: stdin !== undefined });
  // Print beside the list reporter's lines. Keep stdout free for reporters that use it.
  const print = (line: string): void => options.processOutput.printLine(line);
  /**
   * Stops the run if nobody acts on a pause, as with a held step. A terminal
   * pause has no idle limit.
   */
  const restartIdle = (): void => {
    clearTimeout(idle);

    if (stdin === undefined && shown !== undefined) {
      idle = setTimeout(stop, IDLE_STOP_MS);
    }
  };
  let attach: StepHoldContext['attach'] | undefined;
  const { server, endAttachments } = commandServer({
    version,
    attach: () => attach,
    onError: (cause) => print(`closing an attachment failed: ${codedMessage(cause)}`),
    step: (client, { action, log }) => {
      // Reject a start command here. It waits for the run it started to fail.
      if (log !== undefined) {
        client.destroy();
        return;
      }
      if (ended !== undefined) {
        client.end(`${JSON.stringify(ended)}\n`);
        return;
      }
      client.on('close', () => waiting.delete(client));
      if (action === 'stop') {
        waiting.set(client, '');
        stop();
      } else if (shown === undefined) {
        waiting.set(
          client,
          `e2e run --step ${action} was not applied: it came before the next pause, so it waited for that pause or the end; send it again to apply it.\n`,
        );
      } else {
        // Register the command first so it receives the next pause, even if
        // release shows it right away.
        waiting.set(client, '');
        const key = action === 'next' ? 'continue' : 'rest';

        keyboard?.closeViewer();
        gate.press(key, { guard: false });
      }
    },
  });

  /** Stops reading pause keys and returns keyboard control to `keys`. */
  const closeKeyboard = (): void => {
    if (keyboard === undefined) {
      return;
    }

    keyboard.close();
    keyboard = undefined;
    keys?.resume();
  };

  /** Opens the keyboard listener so Ctrl-C is handled between held steps too. */
  const openKeyboard = (): void => {
    if (stdin === undefined || keyboard !== undefined) {
      return;
    }

    keys?.pause({ interrupt: false });
    keyboard = new StepKeyboard(stdin, gate, options.processOutput, { stream, holdSteps: steps, interrupt });
    keyboard.listen();
  };

  if (steps) {
    openKeyboard();
  }

  /**
   * Shows a hold to the reporters: in a terminal, under its test with the
   * keys below the summary. Without a terminal, the pause is also printed
   * in the run's output, with the commands that answer it.
   *
   * Each new pause answers waiting commands. After the run starts stopping,
   * new pauses aren't printed and commands receive the run's final answer.
   */
  const show = (prompt: StepPrompt | undefined, context: StepHoldContext): void => {
    if (stdin !== undefined) {
      if (prompt === undefined && !steps) {
        closeKeyboard();
      } else if (prompt !== undefined) {
        openKeyboard();
      }
    }

    context.show(prompt);

    const first = prompt?.steps[0].step;

    if (first === shown) {
      return;
    }

    shown = first;
    restartIdle();

    if (prompt === undefined || options.interruptSignal?.aborted === true) {
      return;
    }

    // In a terminal, read the screen only when a command is waiting.
    if (stdin !== undefined && waiting.size === 0) {
      return;
    }

    void context.readScreen().then((screen) => {
      // Discard the screen if the pause ended or the run started stopping
      // while it was being read. Waiting commands get the next pause or end.
      if (shown !== first || options.interruptSignal?.aborted === true) {
        return;
      }

      const text = stepPromptText(prompt, screen);

      if (stdin === undefined) {
        print(text.trimEnd());
      }

      answerWaiting(waiting, { text, exitCode: 0 }, sent);
    });
  };
  const onPause: BeforeStep = async (step, context) => {
    attach = context.attach;
    // In a terminal, keys resume the test even if another run owns the socket.
    claimed ??= Promise.resolve()
      .then(() => claim(server, stepAddress(options.cwd ?? process.cwd()), ALREADY_GOING_AT_PAUSE))
      .catch((cause: unknown) => {
        if (stdin === undefined) {
          claimed = undefined;
          throw cause;
        }
        if (errorMessage(cause) === ALREADY_GOING_AT_PAUSE) {
          print('Another run in this directory is controlled with e2e run --step commands, so use the keys for this run.');
          return;
        }

        print(codedMessage(cause));
        print('Only the keys work for this run.');
      });
    await claimed;
    return gate.beforeStep(step, { ...context, show: (prompt) => show(prompt, context) });
  };
  /** Closes the socket and sends the final answer to waiting commands. */
  const end = async (reply: StepReply): Promise<void> => {
    clearTimeout(idle);
    closeKeyboard();
    // Wait for a pending claim so it can't start listening after the server closes.
    await Promise.allSettled([claimed]);
    endAttachments(sent);
    server.close();
    ended = reply;
    answerWaiting(waiting, reply, sent);
    await Promise.race([Promise.all(sent), sleep(FLUSH_MS, undefined, { ref: false })]);
  };

  let outcome: RunOutcome;
  try {
    outcome = await run({ ...options, hold: { ask: onPause, steps, ...(stdin === undefined ? {} : { keyboard: true }) } });
  } catch (cause) {
    await end({ text: `error: ${codedMessage(cause)}\n${RUN_ENDED}`, exitCode: exitCodeForCategory(classifyError(cause).category) });
    throw cause;
  }
  await end({ text: RUN_ENDED, exitCode: outcome.exitCode });
  return outcome;
}
