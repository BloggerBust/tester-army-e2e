/**
 * The VHS tape `record-terminal.ts` hands to `vhs`: fixed settings so every
 * recording in a PR looks the same, then either one command typed into the
 * shell or the caller's own keystrokes.
 */

export interface TapeOptions {
  /** Absolute path of the video; the extension (.mp4, .webm, .gif) picks the format. */
  out: string;
  width: number;
  height: number;
  fontSize: number;
  /** Seconds the last frame stays on screen. */
  hold: number;
}

export interface CommandTape extends TapeOptions {
  command: string;
  /** Seconds the command may run before the recording gives up. */
  timeout: number;
}

const QUOTES = ['"', "'", '`'];

/** `text` as a tape string. VHS has no escapes, so the quote must not occur in it. */
export function quoted(text: string): string | undefined {
  if (/[\r\n]/.test(text)) return undefined;
  const quote = QUOTES.find((candidate) => !text.includes(candidate));
  return quote === undefined ? undefined : `${quote}${text}${quote}`;
}

/** One argument as bash reads it back: bare when safe, single-quoted otherwise. */
function shellWord(argument: string): string {
  return /^[\w@%+=:,./-]+$/.test(argument) ? argument : `'${argument.replaceAll("'", `'\\''`)}'`;
}

/**
 * The line to type for `argv`. One argument is a shell line, typed as given
 * (`"a && b"`); several are a program and its arguments, each quoted so bash
 * runs what the caller's shell parsed.
 */
export function shellLine(argv: readonly string[]): string {
  return argv.length === 1 ? (argv[0] ?? '') : argv.map(shellWord).join(' ');
}

function settings(options: TapeOptions): string[] {
  const out = quoted(options.out);
  if (out === undefined) throw new Error(`cannot quote the output path ${options.out}`);
  return [
    `Output ${out}`,
    'Set Shell bash',
    `Set FontSize ${options.fontSize}`,
    `Set Width ${options.width}`,
    `Set Height ${options.height}`,
    'Set Padding 24',
    'Set TypingSpeed 15ms',
  ];
}

/** A tape that types `command`, waits for the prompt to come back, and holds the last frame. */
export function commandTape(options: CommandTape): string {
  const command = quoted(options.command);
  if (command === undefined) {
    throw new Error('the command spans lines or uses all of ", \', and `: put it in a script, or write the keys with --tape');
  }
  return [...settings(options), `Type ${command}`, 'Enter', `Wait@${options.timeout}s`, `Sleep ${options.hold}s`, ''].join('\n');
}

/** A tape that plays the caller's keystrokes (`body`, VHS commands) under the shared settings. */
export function keysTape(options: TapeOptions, body: string): string {
  const own = body.split(/\r?\n/).find((line) => /^\s*(Output|Set\s+(Shell|Width|Height|FontSize))\b/.test(line));
  if (own !== undefined) throw new Error(`the tape sets "${own.trim()}", which record-terminal owns: remove the line`);
  return [...settings(options), body.trimEnd(), `Sleep ${options.hold}s`, ''].join('\n');
}
