/** Reads the held attempt's ID from the pause header. */
export const PAUSE_ID_PATTERN = /[a-hjkmnp-z2-9]{4}/;

/** Reads the held attempt's ID from its pause header. */
export function printedPauseId(text: string): string {
  const id = new RegExp(`^[Pp]aused \\((${PAUSE_ID_PATTERN.source})\\) `, 'm').exec(text)?.[1];

  if (id === undefined) {
    throw new Error(`no attachment id in output:\n${text}`);
  }

  return id;
}
