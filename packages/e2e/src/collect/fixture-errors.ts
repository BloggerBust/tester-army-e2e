/** The error a broken fixture rule raises, and how its message says where the code is. */

import { CollectionError } from '@e2e-dev/core/lib/internal/errors';
import { projectRelativePath, type SourceLocation } from '@e2e-dev/core/lib/internal/source';

/**
 * A fixture rule broken by code declared at a known line. `declaredAt` is
 * absolute; whoever knows the project root puts it in front of the message
 * (`declarationSite`).
 */
export class FixtureUseError extends CollectionError {
  constructor(
    message: string,
    readonly declaredAt: SourceLocation | undefined,
  ) {
    super(message);
    this.name = 'FixtureUseError';
  }
}

/**
 * Where the code a collection error is about was declared, as the message
 * names it: `tests/support.ts:12`, relative to the project root. `file` when
 * the error carries no line, or one outside the project. Read structurally: a
 * test file may load a second copy of this module.
 */
export function declarationSite(cause: unknown, projectRoot: string, file: string): string {
  const site = (cause as { declaredAt?: Partial<SourceLocation> } | null)?.declaredAt;
  if (typeof site?.file !== 'string' || typeof site.line !== 'number') return file;
  const relative = projectRelativePath(projectRoot, site.file);
  return relative === undefined ? file : `${relative}:${site.line}`;
}
