/**
 * Terminal key handling for `--step` and `screen.pause()`. While the test
 * waits, its screen or app log is available on the alternate screen.
 */

import { sanitizeText } from '@e2e-dev/core/lib/internal/errors';
import { fitColumns, terminalColumns, terminalRows, visibleWidth } from '../report/format.ts';
import { LiveWindow } from '../report/live-window.ts';
import { openAlternateScreen, uncaptured, type OutputStream, type RunnerOutput } from '../run/process-output.ts';
import { Keyboard, type Keypress } from './keyboard.ts';
import { stepKeyOf, type HeldPromptStep, type StepGate, type StepView } from './step.ts';

type StepKeyboardOptions = {
  readonly stream: () => OutputStream | undefined;
  readonly holdSteps: boolean;
  readonly interrupt: () => void;
};

/** Terminal key routing for the viewer and step prompt. */
export class StepKeyboard {
  private readonly keyboard: Keyboard<Keypress>;
  private viewer: StepViewer | undefined;

  constructor(
    stdin: NodeJS.ReadStream,
    private readonly gate: StepGate,
    private readonly output: RunnerOutput,
    private readonly options: StepKeyboardOptions,
  ) {
    this.keyboard = new Keyboard(stdin, (press) => press);
  }

  /** Restores the main screen if the viewer is open. */
  closeViewer(): void {
    this.viewer?.close();
  }

  /** Reads prompt and viewer keys in raw mode. */
  listen(): void {
    const { stream, holdSteps, interrupt } = this.options;

    this.keyboard.listen((press) => {
      const key = stepKeyOf(press);

      if (key === 'interrupt') {
        this.closeViewer();
        interrupt();
        return;
      }

      if (key === 'suspend') {
        this.closeViewer();
        this.keyboard.suspend();
        return;
      }

      if (this.viewer !== undefined) {
        this.viewer.press(press);
        return;
      }

      if (key === 'screen' || key === 'logs') {
        const held = this.gate.inspect();

        const terminal = stream();
        if (held !== undefined && terminal !== undefined) {
          this.viewer = new StepViewer(terminal, held, this.output, () => {
            this.viewer = undefined;
            this.gate.guardKeys();
          });
          void this.viewer.show(key);
        }
      } else if (key !== undefined && (holdSteps || (key !== 'test' && key !== 'rest'))) {
        this.gate.press(key);
      }
    });
  }

  /** Restores the main screen and turns off raw mode. */
  close(): void {
    this.closeViewer();
    this.keyboard.close();
  }
}

/** The screen or app log of a single wait on the terminal's alternate screen. */
class StepViewer {
  private readonly terminal: ReturnType<typeof openAlternateScreen>;
  private readonly resume: () => void;
  private readonly screenTitle: string;
  private readonly logTitle: string;
  private view: StepView = 'screen';
  private lines: readonly string[] = [];
  private offset = 0;
  private request: symbol | undefined;

  constructor(
    private readonly stream: OutputStream,
    private readonly held: HeldPromptStep,
    private readonly output: RunnerOutput,
    private readonly onClose: () => void,
  ) {
    const { step, number, context: { labels } } = held;
    const test = sanitizeText(`${labels.title} [${labels.target}]`).replace(/\s+/g, ' ');
    this.screenTitle = `Screen ${step.kind === 'pause' ? 'at screen.pause()' : `before step ${number}`} · ${test}`;
    this.logTitle = `App log · ${test}`;
    this.resume = uncaptured(() => LiveWindow.suspend());
    this.terminal = openAlternateScreen(stream);

    process[stream].on('resize', this.draw);
    held.context.signal.addEventListener('abort', this.close, { once: true });
  }

  /** Reads the selected view. Replies to earlier reads are ignored after a switch or close. */
  async show(view: StepView): Promise<void> {
    const request = Symbol();
    this.request = request;
    this.view = view;
    this.lines = [view === 'screen' ? 'Reading the screen…' : 'Reading the app log…'];
    this.offset = 0;

    this.draw();
    const { context } = this.held;
    let lines: readonly string[];

    if (view === 'screen') {
      const screen = await context.readScreen();
      lines = screen === undefined ? ['The screen could not be read.'] : sanitizeText(screen).replaceAll('\t', '  ').split('\n');
    } else {
      const logs = await context.readLogs();
      lines = logs === undefined || logs.length === 0 ? ['The app has not logged anything.'] : logs;
    }

    if (this.request !== request) {
      return;
    }

    this.request = undefined;
    this.lines = lines;
    this.offset = view === 'logs' ? lines.length : 0;
    this.draw();
  }

  /** Handles keys in the viewer. These keys aren't sent to the test. */
  press(press: Keypress): void {
    if (press.ctrl) {
      return;
    }

    switch (press.name) {
      case 'up':
      case 'k':
        this.offset -= 1;
        break;
      case 'down':
      case 'j':
        this.offset += 1;
        break;
      case 'pageup':
      case 'b':
        this.offset -= this.pageRows;
        break;
      case 'pagedown':
      case 'space':
        this.offset += this.pageRows;
        break;
      case 'g':
        this.offset = press.sequence === 'G' ? this.lines.length : 0;
        break;
      case 's':
      case 'l':
        void this.show(press.name === 's' ? 'screen' : 'logs');
        return;
      case 'p': {
        if (this.request !== undefined) {
          return;
        }

        const text = [this.title, ...this.lines].join('\n');
        // Queue the text while the live window is suspended so it prints before the prompt is repainted.
        this.output.printLine(text);
        this.close();
        return;
      }
      case 'q':
      case 'escape':
        this.close();
        return;
      default:
        return;
    }

    this.draw();
  }

  /** Leaves the alternate screen before redrawing the run. */
  readonly close = (): void => {
    this.request = undefined;
    process[this.stream].off('resize', this.draw);
    this.held.context.signal.removeEventListener('abort', this.close);
    this.onClose();

    this.terminal.close();
    uncaptured(this.resume);
  };

  private get title(): string {
    return this.view === 'screen' ? this.screenTitle : this.logTitle;
  }

  private get pageRows(): number {
    const rows = terminalRows();
    return Math.max(0, rows - (rows >= 5 ? 4 : 2));
  }

  /** Paints one row per line. One column stays free to prevent wrapping. */
  private readonly draw = (): void => {
    const columns = Math.max(1, terminalColumns() - 1);
    const page = this.pageRows;
    this.offset = Math.max(0, Math.min(this.offset, this.lines.length - page));
    const visible = this.lines.slice(this.offset, this.offset + page);
    const range = `${this.offset + 1}-${this.offset + visible.length} of ${this.lines.length}`;
    const title = fitColumns(this.title, Math.max(1, columns - range.length - 2));
    const heading = columns > range.length + 2 && visible.length > 0 ? `${title}${' '.repeat(columns - visibleWidth(title) - range.length)}${range}` : this.title;
    const other = this.view === 'screen' ? 'l to show the app log' : 's to show the screen';
    const help = `  press q to go back, press ↑ ↓ to scroll, press ${other}, press p to print`;
    const gap = terminalRows() >= 5 ? [''] : [];
    const rows = [heading, ...gap, ...visible.map((line) => `  ${line}`)];

    while (rows.length < terminalRows() - 1) {
      rows.push('');
    }

    rows.push(help);
    this.terminal.write(`\u001b[H\u001b[2J${rows.slice(0, terminalRows()).map((line) => fitColumns(line, columns)).join('\r\n')}`);
  };
}
