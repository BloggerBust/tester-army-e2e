import { spawn } from 'node:child_process';

export interface BrowserCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * The OS command that opens an already-validated URL (`http:`, `https:`, or
 * `file:` for a local report) in the user's browser without invoking a shell.
 */
export function platformOpenCommand(platform: NodeJS.Platform, openable: string): BrowserCommand {
  if (platform === 'darwin') return { command: 'open', args: [openable] };
  // `rundll32` hands the URL to the handler for its scheme as it is, with
  // no command line of its own for the URL to be read as.
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', openable] };
  return { command: 'xdg-open', args: [openable] };
}

/** Spawns the platform browser opener detached, calling `onError` if launch fails. */
export function spawnBrowserCommand(command: BrowserCommand, onError?: (cause: unknown) => void): void {
  try {
    const child = spawn(command.command, [...command.args], { stdio: 'ignore', detached: true });
    child.on('error', (cause) => onError?.(cause));
    child.unref();
  } catch (cause) {
    onError?.(cause);
  }
}
