/** A log a fixture project's hooks, fixtures, and bodies append to, so a test can read the order they ran in. */

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Points the fixture project at a fresh log file (`HOOK_LOG`) and reads it back as its lines. */
export function hookLog(name: string): { lines(): string[] } {
  const logPath = path.join('/tmp', `e2e-${name}-${Date.now()}.log`);
  process.env['HOOK_LOG'] = logPath;
  return { lines: () => readFileSync(logPath, 'utf8').trim().split('\n') };
}

/** `tests/log.ts` of a fixture project: `log(entry)` appends one line to the file `hookLog` reads. */
export const LOG_MODULE = `import { appendFileSync } from 'node:fs';
export const log = (entry: string) => appendFileSync(process.env.HOOK_LOG!, entry + '\\n');
`;
