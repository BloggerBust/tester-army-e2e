/**
 * Defines the socket used by later commands from the same directory
 * (`e2e run --step next`, `rest`, `stop`) and for MCP attachments. See
 * `cli/step-control.ts` for request handling.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { z } from 'zod';

/** Where a stepped run listens, the lock it holds while it claims that, and the file its output goes to (one per starting command). */
export interface StepAddress {
  readonly socket: string;
  readonly lock: string;
  readonly log: string;
}

/**
 * Where the stepped run started from `cwd` listens and logs. The directory
 * holding them is created for this user alone, and refused when someone else
 * owns it or can read it: the socket drives the run and the log holds its output.
 */
export function stepAddress(cwd: string): StepAddress {
  const id = createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
  const uid = process.getuid?.();
  const dir = path.join(os.tmpdir(), uid === undefined ? 'e2e-step' : `e2e-step-${uid}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (uid !== undefined) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
      throw new Error(`${dir} must be a directory only you can open; remove it and run again`);
    }
  }
  return {
    socket: process.platform === 'win32' ? String.raw`\\.\pipe\e2e-step-` + id : path.join(dir, `${id}.sock`),
    lock: path.join(dir, `${id}.lock`),
    log: path.join(dir, `${id}-${process.pid}.log`),
  };
}

/** One JSON message `schema` reads, or undefined when the line is not one. */
export function parseLine<T>(line: string, schema: z.ZodType<T>): T | undefined {
  try {
    return schema.parse(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/** Delivers complete lines even when split across chunks. Return false from receive to stop reading. */
export function readSocketLines(socket: Socket, receive: (line: string) => boolean): void {
  let buffer = '';
  socket.setEncoding('utf8');

  /** Keeps an incomplete line until the next chunk arrives. */
  const read = (chunk: string): void => {
    buffer += chunk;

    for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);

      if (receive(line)) {
        continue;
      }

      socket.off('data', read);
      return;
    }
  };

  socket.on('data', read);
}
