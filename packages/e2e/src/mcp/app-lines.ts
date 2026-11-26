/**
 * The app half of `open_session`'s summary: where the app is, the port the
 * session assigned, and the services and process it started, so an agent
 * doesn't need to read the config to learn what's listening. Nothing that
 * may carry a secret is printed: `args` are left out, `env` and `inheritEnv`
 * are named without values, and the readiness URL loses userinfo and query.
 */

import type { ResolvedTarget } from '@e2e-dev/core/lib/config/resolve';
import { launchesPinnedApp } from '@e2e-dev/core/lib/config/targets';
import { printableUrl } from '@e2e-dev/core/lib/internal/urls';
import type { CommandConfig } from '@e2e-dev/core/lib/types';

/**
 * Returns the `App:`, `Services:`, and `Process:` lines for a session on
 * `target`. `ranTest` is true when the session ran a test first and that
 * test launched the pinned app. `services` lists the config's services the
 * session holds.
 */
export function appLines(target: ResolvedTarget, ranTest: boolean, services: readonly string[]): string[] {
  const { app } = target;
  const lines: string[] = [];

  if (app.base !== undefined) {
    const assigned = app.portRequest?.port;

    lines.push(`App: ${app.base.href}${assigned === undefined ? '' : ` (port ${assigned}, assigned for the declared port 0)`}.`);
  } else if (launchesPinnedApp(target)) {
    const pinned = app.bundleId ?? app.appPath;

    lines.push(ranTest ? `App: ${pinned}.` : `App: ${pinned}, launched fresh.`);
  }

  if (services.length > 0) {
    lines.push(`Services: ${services.join(', ')}. Every session open on this config file shares them.`);
  }

  if (app.command !== undefined && app.readyUrl !== undefined) {
    const outside = services.length > 0 ? '' : '; a database or other service the app uses runs outside e2e';

    lines.push(`Process: ${describeCommand(app.command, app.readyUrl)} e2e starts no other app process for this session${outside}.`);
  } else if (app.base !== undefined) {
    lines.push('Process: none; the target declares no app.command, so the app runs outside e2e.');
  }

  return lines;
}

/** One app command as the session ran it: its executable, where it answers, and what it was given. */
function describeCommand(command: CommandConfig, readyUrl: string): string {
  const facts = [`ready at ${printableUrl(readyUrl)}`];
  if (command.reuseExisting === true) facts.push('reuseExisting: a server already answering there is used instead of starting one');
  const env = typeof command.env === 'function' ? undefined : Object.keys(command.env ?? {});
  if (env === undefined) facts.push('env from a function');
  else if (env.length > 0) facts.push(`env ${env.join(', ')}`);
  if (command.inheritEnv !== undefined && command.inheritEnv.length > 0) facts.push(`inherits ${command.inheritEnv.join(', ')}`);
  if (command.cwd !== undefined) facts.push(`cwd ${command.cwd}`);
  if (command.log !== undefined) facts.push(`log ${command.log}`);
  return `app.command ${JSON.stringify(command.executable)} (${facts.join('; ')}).`;
}
