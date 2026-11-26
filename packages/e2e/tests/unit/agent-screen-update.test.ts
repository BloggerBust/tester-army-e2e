import { describe, expect, it } from 'vitest';
import type { ExecutorObservation } from '@e2e-dev/core/lib/agent/executor';
import { reportsNoEffect, reportsScreenChange, ScreenPresenter } from '@e2e-dev/core/lib/agent/screen-update';

function screen(revision: string, lines: readonly string[], extra: Partial<ExecutorObservation> = {}): ExecutorObservation {
  return {
    revision,
    text: lines.join('\n'),
    truncated: false,
    viewport: { width: 1280, height: 720 },
    ...extra,
  };
}

const HOME = [
  '#n1 document "Home"',
  ' #n2 heading "Welcome"',
  ' #n3 button "Increment"',
  ' #n4 status "Counter" text="0"',
  ' #n5 link "About" href="/about"',
  ' #n6 textbox "Email"',
];

describe('ScreenPresenter', () => {
  describe('says what a wait can count as progress', () => {
    const textOf = (output: ReturnType<ScreenPresenter['present']>) => (typeof output === 'string' ? output : output.text);
    const noTree = (revision: string, extra: Partial<ExecutorObservation> = {}) =>
      screen(revision, ['[semantic capture unavailable: no nodes were read]'], { treeUnavailable: true, truncated: true, ...extra });

    it('names a new location when nothing listed changed, and does not blame the control for it', () => {
      const presenter = new ScreenPresenter();
      presenter.open(screen('b1', HOME, { path: '/products/new' }));
      const tapped = textOf(presenter.present(screen('b2', HOME, { path: '/products/123' }), { lead: 'Tapped #n3.', expectChange: true }));
      expect(tapped).toContain('The location changed to /products/123. ');
      expect(tapped).not.toContain('had no visible effect');
      // A look is what the wait counts: observe's result leads with "Observed." and the line after it.
      const looked = textOf(presenter.present(screen('b3', HOME, { path: '/products/124' }), { lead: 'Observed.' }));
      expect(looked).toContain('The location changed to /products/124. ');
      expect(reportsScreenChange(looked)).toBe(true);
      const still = textOf(presenter.present(screen('b4', HOME, { path: '/products/124' }), { lead: 'Observed.' }));
      expect(still).not.toContain('The location changed');
      expect(reportsScreenChange(still)).toBe(false);
    });

    it('counts tree recovery even when the location contains the unavailable status', () => {
      const presenter = new ScreenPresenter();
      const location = { path: 'Editor\nsemantic capture unavailable' };
      presenter.open(screen('b1', HOME, location));
      expect(reportsScreenChange(textOf(presenter.present(noTree('b2', location), { lead: 'Observed.' })))).toBe(false);
      expect(reportsScreenChange(textOf(presenter.present(noTree('b3', location), { lead: 'Observed.' })))).toBe(false);
      const back = textOf(presenter.present(screen('b4', HOME, location), { lead: 'Observed.' }));
      expect(back).toContain('Current screen (revision b4');
      expect(reportsScreenChange(back)).toBe(true);
    });

    it('counts a listed change even when the location contains the unchanged status', () => {
      const presenter = new ScreenPresenter();
      const location = { path: 'Editor): no listed node changed. ', truncated: true };
      presenter.open(screen('b1', HOME, location));
      const still = presenter.update(screen('b2', HOME, location));
      expect(reportsScreenChange(still)).toBe(false);
      const changed = presenter.update(screen('b3', [...HOME, '#n7 button "Save"'], location));
      expect(reportsScreenChange(changed)).toBe(true);
    });

    it('names a new location while the screen has no tree', () => {
      const presenter = new ScreenPresenter();
      presenter.open(screen('b1', HOME, { path: '/product/edit' }));
      expect(reportsScreenChange(textOf(presenter.present(noTree('b2', { path: '/product/edit' }), { lead: 'Observed.' })))).toBe(false);
      const moved = textOf(presenter.present(noTree('b3', { path: '/product/42' }), { lead: 'Observed.' }));
      expect(moved).toContain('The location changed to /product/42. ');
      expect(reportsScreenChange(moved)).toBe(true);
    });

    it('does not take a capture that leaves the location out for navigation, there or back', () => {
      const presenter = new ScreenPresenter();
      presenter.open(screen('b1', HOME, { path: '/edit' }));
      const without = textOf(presenter.present(screen('b2', HOME), { lead: 'Observed.' }));
      const back = textOf(presenter.present(screen('b3', HOME, { path: '/edit' }), { lead: 'Observed.' }));
      const treeless = textOf(presenter.present(noTree('b4'), { lead: 'Observed.' }));
      for (const text of [without, back, treeless]) {
        expect(text).not.toContain('The location changed');
        expect(reportsScreenChange(text)).toBe(false);
      }
      // A location reported again after a gap is compared with the last one known.
      expect(textOf(presenter.present(screen('b5', HOME, { path: '/view' }), { lead: 'Observed.' }))).toContain('The location changed to /view. ');
    });

    it('reports no tab or location change on the first result of a presenter that was never opened', () => {
      for (const active of [1, 2]) {
        const output = textOf(new ScreenPresenter().present(screen('b1', HOME, { tabs: { count: 2, active }, path: '/p' }), { lead: 'Tapped #n3.' }));
        expect(output).not.toContain('The app opened');
        expect(output).not.toContain('The screen shows tab');
        expect(output).not.toContain('The location changed');
        expect(output).toContain(`tab ${String(active)} of 2`);
      }
    });

    it('says a tab opened even while the screen has no tree', () => {
      const presenter = new ScreenPresenter();
      presenter.open(screen('b1', HOME));
      presenter.present(noTree('b2'), { lead: 'Observed.' });
      const opened = textOf(presenter.present(noTree('b3', { tabs: { count: 2, active: 1 } }), { lead: 'Observed.' }));
      expect(opened).toContain('The app opened');
      expect(reportsScreenChange(opened)).toBe(true);
    });
  });

  it('retires semantic history through repeated unavailable captures and shows recovery whole', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', ['#root', ' #save button "Save"']));
    const pixels = { data: new Uint8Array([1]), mediaType: 'image/png' as const, width: 1, height: 1, scale: 1, maskedRegionCount: 0 };
    for (const revision of ['b2', 'b3']) {
      const output = presenter.present(screen(revision, [
        '[semantic capture unavailable: no nodes were read; previous node ids are no longer valid. Use the screenshot, never infer absence from this listing]',
      ], { treeUnavailable: true, truncated: true, pixels }));
      expect(output).toMatchObject({ pixels });
      const text = typeof output === 'string' ? output : output.text;
      expect(text).toContain('semantic capture unavailable');
      expect(text).toContain('previous node ids are no longer valid');
      expect(text).not.toContain('keeps the id');
      expect(text).not.toContain('no listed node changed');
      expect(text).not.toContain('removed');
    }
    const recovered = presenter.update(screen('b4', ['#root', ' #save button "Save"']));
    expect(recovered).toContain('Current screen (revision b4');
    expect(recovered).toContain('#save button "Save"');
    expect(recovered).not.toContain('Screen changes');
  });

  it('names the first screen without listing it, and reports later changes against it', () => {
    const presenter = new ScreenPresenter();
    expect(presenter.unlisted(screen('b1', HOME, { path: '/' }))).toBe('revision b1, path /, 6 nodes');
    expect(presenter.update(screen('b2', HOME, { path: '/' }))).toContain('Screen unchanged since revision b1');
    const changed = presenter.update(screen('b3', [...HOME, ' #new button "New"'], { path: '/' }));
    expect(changed).toContain('Screen changes since revision b2');
    expect(changed).toContain('added #new button "New"');
    expect(changed).not.toContain(HOME[1]);
  });

  it('sends the first screen whole, with its revision, path, and size', () => {
    const presenter = new ScreenPresenter();
    const text = presenter.initial(screen('b1', HOME, { path: '/' }));
    expect(text.split('\n')[0]).toBe('Current screen (revision b1, path /, 6 nodes):');
    expect(text).toContain(' #n3 button "Increment"');
  });

  it('says a tab the app opened stays in the background, then shows another tab whole even when its ids match', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', HOME, { path: '/' }));
    const opened = presenter.update(screen('b2', HOME, { path: '/', tabs: { count: 2, active: 1 } }), { lead: 'Tapped #n3.', expectChange: true });
    // The tab is the tap's effect: no control is blamed for the unchanged screen.
    expect(opened).toContain('Tapped #n3.\n\nThe app opened a new tab (tab 2 of 2). The screen still shows tab 1; use switch_tab to see it. Screen unchanged since revision b1');
    const popup = ['#n1 document "Verification"', ' #n2 text "Code TAB-88421"'];
    const switched = presenter.update(screen('b3', popup, { path: '/verify', tabs: { count: 2, active: 2 } }), { lead: 'Switched to tab 2.' });
    expect(switched).toContain('The screen shows tab 2 of 2 now. Current screen (revision b3, path /verify, tab 2 of 2, 2 nodes):');
    expect(switched).toContain(' #n2 text "Code TAB-88421"');
    expect(switched).not.toContain('changed #n1');
    const back = presenter.update(screen('b4', HOME, { path: '/', tabs: { count: 2, active: 1 } }), { lead: 'Switched to tab 1.' });
    expect(back).toContain('The screen shows tab 1 of 2 now. Current screen (revision b4, path /, tab 1 of 2, 6 nodes):');
    expect(presenter.update(screen('b5', HOME, { path: '/', tabs: { count: 2, active: 1 } }))).toContain('Screen unchanged since revision b4');
    const two = presenter.update(screen('b6', HOME, { path: '/', tabs: { count: 4, active: 1 } }));
    expect(two).toContain('The app opened 2 new tabs (tabs 3 to 4 of 4). The screen still shows tab 1; use switch_tab to see one.');
    const closed = presenter.update(screen('b7', HOME, { path: '/' }));
    expect(closed).toContain('The other tabs closed; the screen shows the one tab still open. Current screen (revision b7, path /, 6 nodes):');
  });

  it('reports a changed and an added line, in document order, keyed by stable ids', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', HOME));
    const next = [...HOME];
    next[3] = ' #n4 status "Counter" text="1"';
    next.push(' #n7 button "Late arrival"');
    const text = presenter.update(screen('b2', next), { lead: 'Tapped #n3.' });
    expect(text.split('\n')).toEqual([
      'Tapped #n3.',
      '',
      'Screen changes since revision b1 (now revision b2, 7 nodes): 1 added, 1 changed. Every node not listed as removed is still on screen under the id you have.',
      'changed #n4 status "Counter" text="1" (was: #n4 status "Counter" text="0")',
      'added #n7 button "Late arrival"',
    ]);
  });

  it('lists removed lines after the additions', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', HOME));
    const next = HOME.filter((line) => !line.includes('#n5'));
    const text = presenter.update(screen('b2', next));
    expect(text).toContain('1 removed.');
    expect(text).toContain('removed #n5 link "About" href="/about"');
    expect(text).not.toContain('added ');
  });

  it('says so when nothing changed, and blames the action when one was expected to change something', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', HOME));
    expect(presenter.update(screen('b2', HOME))).toBe(
      'Screen unchanged since revision b1 (re-observed as revision b2); the ids you have stay valid.',
    );
    const afterAction = presenter.update(screen('b3', HOME), { lead: 'Tapped #n3.', expectChange: true });
    expect(afterAction).toContain('Tapped #n3.');
    expect(afterAction).toContain('re-observed as revision b3');
  });

  it('says no listed node changed after an action, never that it had no effect, when no screenshot was compared', () => {
    const presenter = new ScreenPresenter();
    const shot = (byte: number) => ({ data: new Uint8Array([byte]), mediaType: 'image/png' as const, width: 1, height: 1, scale: 1, maskedRegionCount: 0 });
    const textOf = (output: ReturnType<ScreenPresenter['present']>) => (typeof output === 'string' ? output : output.text);
    presenter.open(screen('b1', HOME));
    // A tap that only fills a drawn dot leaves the tree as it was: the tree cannot tell a drawn effect from none.
    const treeOnly = textOf(presenter.present(screen('b2', HOME), { lead: 'Tapped #n3.', expectChange: true }));
    expect(treeOnly).toContain('No listed node changed within the wait after this action');
    expect(treeOnly).toContain('a drawn change needs a screenshot to see');
    expect(treeOnly).not.toContain('had no visible effect');
    expect(treeOnly).not.toContain('look for another way');
    // The first screenshot has none before it to differ from, so it proves no more than the tree.
    const first = textOf(presenter.present(screen('b3', HOME, { pixels: shot(1) }), { lead: 'Tapped #n3.', expectChange: true }));
    expect(first).not.toContain('had no visible effect');
  });

  it('reads no effect off the report of an unchanged screen, never off app text in a listing of changes', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', HOME));
    expect(reportsNoEffect(presenter.update(screen('b2', HOME), { lead: 'Tapped #n3.', expectChange: true }))).toBe(true);
    // Nothing was expected to change, so nothing is blamed.
    expect(reportsNoEffect(presenter.update(screen('b3', HOME)))).toBe(false);
    // A status the tap revealed quotes the report's own words; the tap still changed the screen.
    const quoted = presenter.update(
      screen('b4', [...HOME, ' #n7 status "No listed node changed within the wait after this action (as the docs say)"']),
      { lead: 'Tapped #n3.', expectChange: true },
    );
    expect(quoted).toContain('added #n7 status');
    expect(reportsNoEffect(quoted)).toBe(false);
  });

  it('keeps the listing as the only evidence, and says to try another way, when the engine captures no screenshot', () => {
    const textOf = (output: ReturnType<ScreenPresenter['present']>) => (typeof output === 'string' ? output : output.text);
    // An engine that captures none says so once asked; from then on the listing is all there is.
    const denied = new ScreenPresenter();
    denied.open(screen('c1', HOME));
    denied.present(screen('c2', HOME, { pixelsWithheld: 'UNSUPPORTED_CAPABILITY' }));
    const after = textOf(denied.present(screen('c3', HOME), { lead: 'Tapped #n3.', expectChange: true }));
    expect(after).toContain('No screenshot can be taken in this step');
    expect(after).toContain('look for another way rather than repeating it');
    expect(after).toContain('If a change was expected and the control commits something (a save, a submit), it may still have gone through: check before you commit again by any route. Otherwise');
    expect(after).not.toContain('needs a screenshot to see');
  });

  it('says the screenshot changed, not that the control had no effect, when the listing stood still under a moved image', () => {
    const presenter = new ScreenPresenter();
    const shot = (byte: number) => ({ data: new Uint8Array([byte]), mediaType: 'image/png' as const, width: 1, height: 1, scale: 1, maskedRegionCount: 0 });
    const textOf = (output: ReturnType<ScreenPresenter['present']>) => (typeof output === 'string' ? output : output.text);
    presenter.open(screen('b1', HOME, { pixels: shot(1) }));
    const moved = textOf(presenter.present(screen('b2', HOME, { pixels: shot(2) }), { lead: 'Tapped #n3.', expectChange: true }));
    expect(moved).toContain('Tapped #n3.');
    expect(moved).toContain('listed nodes unchanged; the screenshot changed');
    expect(moved).not.toContain('had no visible effect');
    // The same image again: the tree describes this screen, so the control is blamed as before.
    const still = textOf(presenter.present(screen('b3', HOME, { pixels: shot(2) }), { lead: 'Tapped #n3.', expectChange: true }));
    expect(still).toContain('had no visible effect');
    expect(still).toContain('If a change was expected and the control commits something (a save, a submit), it may still have gone through: check before you commit again by any route. Otherwise');
    expect(still).not.toContain('the screenshot changed');
    // A moved image is reported whether or not a change was expected.
    const observed = textOf(presenter.present(screen('b4', HOME, { pixels: shot(3) }), { lead: 'Observed.', expectChange: false }));
    expect(observed).toContain('listed nodes unchanged; the screenshot changed');
    expect(observed).not.toContain('Screen unchanged since');
  });

  it('treats unproven masking as one screen\'s refusal, not the step\'s', () => {
    const textOf = (output: ReturnType<ScreenPresenter['present']>) => (typeof output === 'string' ? output : output.text);
    const presenter = new ScreenPresenter();
    presenter.open(screen('b1', HOME));
    presenter.present(screen('b2', HOME, { pixelsWithheld: 'MASKING_UNPROVEN' }));
    const later = textOf(presenter.present(screen('b3', HOME), { lead: 'Tapped #n3.', expectChange: true }));
    expect(later).not.toContain('No screenshot can be taken in this step');
    expect(later).toContain('a drawn change needs a screenshot to see');
  });

  it('ignores focus moving, which every action does, when deciding what changed', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', HOME));
    const focused = [...HOME];
    focused[2] = ' #n3 button "Increment" [focused]';
    expect(presenter.update(screen('b2', focused), { lead: 'Tapped #n3.', expectChange: true })).toContain(
      'No listed node changed within the wait',
    );
    const typed = [...focused];
    typed[5] = ' #n6 textbox "Email" value="a" [focused]';
    typed[2] = ' #n3 button "Increment"';
    const text = presenter.update(screen('b3', typed));
    expect(text).toContain('changed #n6 textbox "Email" value="a" (was: #n6 textbox "Email")');
    expect(text).not.toContain('Increment');
  });

  it('falls back to the whole screen when most of it changed', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', HOME));
    const other = [
      '#n20 document "Pricing"',
      ' #n21 heading "Plans"',
      ' #n22 button "Choose Pro"',
      ' #n23 button "Choose Team"',
    ];
    const text = presenter.update(screen('b2', other, { path: '/pricing' }), { lead: 'Tapped #n5.' });
    expect(text).toContain('The screen changed substantially since revision b1. Current screen (revision b2, path /pricing, 4 nodes):');
    expect(text).toContain(' #n22 button "Choose Pro"');
    expect(text).not.toContain('added ');
  });

  it('compares against the newest screen it rendered, whole or as changes', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', HOME));
    const typed = [...HOME];
    typed[5] = ' #n6 textbox "Email" value="ada@example.test"';
    presenter.update(screen('b2', typed));
    const pressed = [...typed];
    pressed[3] = ' #n4 status "Counter" text="1"';
    const text = presenter.update(screen('b3', pressed));
    // The email line was already reported and is not repeated.
    expect(text).not.toContain('Email');
    expect(text).toContain('changed #n4 status "Counter" text="1" (was: #n4 status "Counter" text="0")');
  });

  it('notes a truncated screen on a change update', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', HOME));
    const next = [...HOME, ' #n8 button "More"'];
    const text = presenter.update(screen('b2', next, { truncated: true }));
    expect(text).toContain('1 added. The screen listing is truncated');
  });

  it('reports no removals against a truncated screen, whose missing nodes were cut, not gone', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', HOME));
    // The walk stopped after four nodes: the link and the textbox may well still exist.
    const text = presenter.update(screen('b2', HOME.slice(0, 4), { truncated: true }));
    expect(text).not.toMatch(/^removed /m);
    expect(text).not.toContain('Screen unchanged');
    expect(text).toContain('no listed node changed. The screen listing is truncated');
  });

  it('does not call a node changed when only its depth moved', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', HOME));
    const next = HOME.map((line) => (line.includes('#n4 ') ? ` ${line}` : line));
    expect(presenter.update(screen('b2', next))).toContain('Screen unchanged since revision b1');
  });
});

describe('ScreenPresenter and the on-screen keyboard', () => {
  const KEYBOARD = [
    ' #n20 keyboard "Padding-Left"',
    '  #n21 key "q"',
    '  #n22 key "w"',
  ];
  const FORM = [
    '#n1 document "Sign in"',
    ' #n2 heading "Welcome back"',
    ' #n3 textbox "Email" value="a@b.c"',
    ' #n4 textbox "Password" value=<secure>',
    ' #n5 link "Forgot password"',
    ' #n6 checkbox "Remember me"',
    ' #n7 button "Log in"',
    ' #n8 text "No account yet?"',
  ];

  it('tells the model when an action closed the keyboard, so a swallowed tap is retried', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', [...FORM, ...KEYBOARD]));
    const text = presenter.update(screen('b2', FORM), { lead: 'Tapped #n7.', expectChange: true });
    expect(text).toContain('removed #n20 keyboard "Padding-Left"');
    expect(text).toContain('The on-screen keyboard closed with this action.');
    expect(text).toContain('act on it again now that the keyboard is down');
    const keys = Array.from({ length: 40 }, (_, i) => `  #k${String(i)} key "${String(i)}"`);
    presenter.initial(screen('b3', [...FORM, ' #n20 keyboard "Padding-Left"', ...keys]));
    const whole = presenter.update(screen('b4', FORM), { lead: 'Tapped #n3.', expectChange: true });
    expect(whole).toContain('changed substantially');
    expect(whole).toContain('The on-screen keyboard closed with this action.');
  });

  it('stays quiet on a truncated listing, an explicit dismissal, or a keyboard that stays or appears, through update and present', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', [...FORM, ...KEYBOARD]));
    expect(presenter.update(screen('b2', FORM, { truncated: true }), { lead: 'Tapped #n7.', expectChange: true })).not.toContain('keyboard closed');
    presenter.initial(screen('b1', [...FORM, ...KEYBOARD]));
    expect(presenter.update(screen('b2', FORM), { lead: 'Dismissed the keyboard.', keyboardNote: false })).not.toContain('keyboard closed');
    presenter.initial(screen('b3', FORM));
    expect(presenter.update(screen('b4', [...FORM, ...KEYBOARD]), { lead: 'Tapped #n2.' })).not.toContain('keyboard closed');
    expect(presenter.update(screen('b5', [...FORM, ...KEYBOARD]), { lead: 'Tapped #n3.' })).not.toContain('keyboard closed');
    const grammar = new ScreenPresenter();
    grammar.open(screen('b1', [...FORM, ...KEYBOARD]));
    expect(grammar.present(screen('b2', FORM), { lead: 'Dismissed the keyboard.', expectChange: false, keyboardNote: false })).not.toContain('keyboard closed');
    grammar.present(screen('b3', [...FORM, ...KEYBOARD]), { lead: 'Tapped #n3.' });
    expect(grammar.present(screen('b4', FORM), { lead: 'Tapped #n7.' })).toContain('The on-screen keyboard closed with this action.');
  });
});
