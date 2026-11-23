import { readFileSync } from 'node:fs';
import { resolveExpression, type SemanticNode } from '@e2e-dev/core/engine';
import { describe, expect, it } from 'vitest';
import { projectSnapshot, type RawSnapshot } from '../../src/nodes.ts';

function load(name: string): RawSnapshot {
  return JSON.parse(readFileSync(new URL(`../fixtures/snapshots/${name}.json`, import.meta.url), 'utf8')) as RawSnapshot;
}

/** Ids as the surface hands them out: one per identity, kept across snapshots. */
function minter(): (identity: string | undefined) => string {
  const ids = new Map<string, string>();
  let fresh = 0;
  return (identity) => {
    if (identity === undefined) return `fresh${(fresh += 1)}`;
    if (!ids.has(identity)) ids.set(identity, `n${ids.size + 1}`);
    return ids.get(identity)!;
  };
}

function project(name: string) {
  return projectSnapshot(load(name), minter());
}

function all(node: SemanticNode): SemanticNode[] {
  return [node, ...(node.children ?? []).flatMap(all)];
}

function byTestId(root: SemanticNode, testId: string): SemanticNode | undefined {
  return all(root).find((node) => node.testId === testId);
}

describe('projectSnapshot', () => {
  it('maps an AppKit form onto the contract vocabulary', () => {
    const { root, bindings } = project('macos/appkit-form');
    expect(root).toMatchObject({ ref: { id: 'root' }, role: 'window', name: 'Spike Form' });
    expect(byTestId(root, 'username')).toMatchObject({ role: 'textbox', name: 'Username', value: 'bob', states: { focused: true } });
    expect(byTestId(root, 'remember')).toMatchObject({ role: 'checkbox', name: 'Remember me', states: { checked: false } });
    expect(byTestId(root, 'remember')?.value).toBeUndefined();
    expect(byTestId(root, 'plan')).toMatchObject({ role: 'combobox', name: 'Plan', value: 'Pro', states: { expanded: false } });
    expect(byTestId(root, 'sign-in')).toMatchObject({ role: 'button', name: 'Sign in' });
    const signIn = byTestId(root, 'sign-in')!;
    expect(bindings.get(signIn.ref.id)).toMatchObject({ ref: '@s1y1hxmo5pexrl:e5', actions: ['Click', 'SetFocus'] });
  });

  it('reports a secure field as a password field with no value', () => {
    const { root } = project('macos/appkit-form');
    const password = byTestId(root, 'password')!;
    expect(password).toMatchObject({ role: 'textbox', name: 'Password', inputPurpose: 'password', states: { secure: true } });
    expect(password.value).toBeUndefined();
  });

  it('drops anonymous wrappers and keeps the controls', () => {
    const { root } = project('macos/sign-in-form');
    const nodes = all(root);
    expect(nodes.filter((node) => node.role === 'group' && node.name === undefined)).toEqual([]);
    expect(byTestId(root, 'username')).toMatchObject({ role: 'textbox', name: 'Username' });
    expect(byTestId(root, 'password')).toMatchObject({ inputPurpose: 'password', states: { secure: true } });
  });

  it("leaves out the window's own title-bar buttons, and keeps the app's", () => {
    const { root } = project('macos/sign-in-form');
    expect(all(root).filter((node) => node.role === 'button').map((node) => node.name)).toEqual(['Sign in']);
    const own = projectSnapshot(
      {
        snapshot_id: 's',
        tree: {
          role: 'window',
          name: 'W',
          children: [
            { role: 'button', name: 'Close', native_id: { kind: 'ax_identifier', value: 'close' }, ref_id: '@s:e1' },
            { role: 'group', name: 'Toolbar', children: [{ role: 'button', name: 'Close', ref_id: '@s:e2' }] },
          ],
        },
      },
      minter(),
    );
    expect(all(own.root).filter((node) => node.role === 'button' && node.name === 'Close')).toHaveLength(2);
    const sheet = projectSnapshot({ snapshot_id: 's', tree: { role: 'window', name: 'About', children: [{ role: 'button', name: 'Close', ref_id: '@s:e1', bounds: { x: 0, y: 0, width: 80, height: 18 } }] } }, minter());
    expect(all(sheet.root).filter((node) => node.role === 'button' && node.name === 'Close')).toHaveLength(1);
    // A small Close button of the app's, below the title bar, is the app's; the one in the title bar is the window's.
    const small = { width: 16, height: 16 };
    const panel = projectSnapshot(
      {
        snapshot_id: 's',
        tree: {
          role: 'window',
          name: 'Panel',
          bounds: { x: 100, y: 200, width: 400, height: 300 },
          children: [
            { role: 'button', name: 'Close', ref_id: '@s:e1', bounds: { x: 108, y: 208, ...small } },
            { role: 'button', name: 'Minimize', ref_id: '@s:e3', bounds: { x: 131, y: 208, ...small } },
            { role: 'button', name: 'Zoom', ref_id: '@s:e4', bounds: { x: 154, y: 208, ...small } },
            { role: 'button', name: 'Close', ref_id: '@s:e2', bounds: { x: 460, y: 320, ...small } },
          ],
        },
      },
      minter(),
    );
    expect(all(panel.root).filter((node) => node.role === 'button' && node.name === 'Close').map((node) => node.rect)).toEqual([{ x: 360, y: 120, ...small }]);
    expect(all(panel.root).filter((node) => node.name === 'Minimize' || node.name === 'Zoom')).toEqual([]);
    // An app's own small Close button in the title bar's far corner stands alone, apart from the window's row of buttons: it is kept.
    const corner = projectSnapshot(
      {
        snapshot_id: 's',
        tree: {
          role: 'window',
          name: 'Panel',
          bounds: { x: 100, y: 200, width: 400, height: 300 },
          children: [
            { role: 'button', name: 'Close', ref_id: '@s:e1', bounds: { x: 108, y: 208, ...small } },
            { role: 'button', name: 'Minimize', ref_id: '@s:e3', bounds: { x: 131, y: 208, ...small } },
            { role: 'button', name: 'Close', ref_id: '@s:e2', bounds: { x: 476, y: 208, ...small } },
          ],
        },
      },
      minter(),
    );
    expect(all(corner.root).filter((node) => node.role === 'button' && node.name === 'Close').map((node) => node.rect)).toEqual([{ x: 376, y: 8, ...small }]);
  });

  it('marks no id stable that sits inside a look-alike, whose own id is new every snapshot', () => {
    const row = { role: 'row', children: [{ role: 'textfield', name: 'Name', ref_id: '@s:e1' }] };
    const screen = projectSnapshot({ snapshot_id: 's', tree: { role: 'window', name: 'W', children: [row, row, { role: 'textfield', name: 'Search', ref_id: '@s:e2' }] } }, minter());
    const stable = (name: string) => [...screen.bindings.values()].filter((binding) => binding.name === name).map((binding) => binding.stable);
    expect(stable('Name')).toEqual([false, false]);
    expect(stable('Search')).toEqual([true]);
  });

  it('answers role and test-id queries through the shared resolver', () => {
    const { root } = project('macos/sign-in-form');
    const [field] = resolveExpression(
      { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'textbox', exact: true }, name: { kind: 'string', value: 'Username', exact: true } } },
      [root],
    );
    expect(field?.testId).toBe('username');
    expect(resolveExpression({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'password', exact: true } } }, [root])).toHaveLength(1);
  });

  it("reads an empty text field's value as the empty string, so getByDisplayValue('') finds it, and a password field's never", () => {
    const { root } = project('macos/sign-in-form');
    const empty = resolveExpression({ kind: 'query', query: { kind: 'displayValue', value: { kind: 'string', value: '', exact: true } } }, [root]);
    expect(empty.map((node) => node.testId)).toEqual(['username']);
    expect(byTestId(root, 'password')?.value).toBeUndefined();
  });

  it('gives a control the same identity in every snapshot, its value aside', () => {
    const mint = minter();
    const before = projectSnapshot(load('macos/appkit-form'), mint);
    const after = projectSnapshot(load('macos/sign-in-form'), mint);
    expect(byTestId(after.root, 'username')?.ref.id).toBe(byTestId(before.root, 'username')?.ref.id);
    expect(byTestId(after.root, 'sign-in')?.ref.id).toBe(byTestId(before.root, 'sign-in')?.ref.id);
    const ids = [...after.bindings.keys()];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives look-alike siblings new ids every snapshot, so one never takes over another', () => {
    const raw: RawSnapshot = {
      snapshot_id: 's1',
      tree: {
        role: 'window',
        name: 'List',
        children: [
          { role: 'button', name: 'Delete', ref_id: '@s1:e1' },
          { role: 'button', name: 'Delete', ref_id: '@s1:e2' },
          { role: 'button', name: 'Done', ref_id: '@s1:e3' },
        ],
      },
    };
    const mint = minter();
    const before = projectSnapshot(raw, mint);
    const after = projectSnapshot({ ...raw, tree: { ...raw.tree, children: raw.tree.children!.slice(1) } }, mint);
    const ids = (screen: typeof before, name: string) => (screen.root.children ?? []).filter((node) => node.name === name).map((node) => node.ref.id);
    expect(ids(after, 'Delete').some((id) => ids(before, 'Delete').includes(id))).toBe(false);
    expect(ids(after, 'Done')).toEqual(ids(before, 'Done'));
  });

  it('keeps an unnamed field its id while it is typed into', () => {
    const mint = minter();
    const field = (value: string): RawSnapshot => ({ snapshot_id: 's', tree: { role: 'window', name: 'Form', children: [{ role: 'textfield', ref_id: '@s:e1', value }] } });
    const ids = ['', 'a', 'ab'].map((value) => projectSnapshot(field(value), mint).root.children?.[0]?.ref.id);
    expect(new Set(ids).size).toBe(1);
  });

  it('reports a value whole, and an image by the contract role', () => {
    const long = 'x'.repeat(600);
    const { root } = projectSnapshot(
      { snapshot_id: 's', tree: { role: 'window', name: 'Form', children: [{ role: 'textfield', name: 'Notes', ref_id: '@s:e1', value: long }, { role: 'image', name: 'Logo' }] } },
      minter(),
    );
    expect(root.children?.[0]?.value).toBe(long);
    expect(root.children?.[1]?.role).toBe('image');
  });

  it('reports the read-only state toBeEditable reads: of a text field always, of a combo box only when it takes text', () => {
    const form = project('macos/sign-in-form').root;
    expect(byTestId(form, 'username')?.states).toMatchObject({ readonly: false });
    expect(byTestId(form, 'password')?.states).toMatchObject({ readonly: false });
    // A pop-up menu takes no text, which is not read-only: no state, as on a device.
    expect(byTestId(form, 'plan')?.states).not.toHaveProperty('readonly');
    const { root } = projectSnapshot(
      {
        snapshot_id: 's',
        tree: {
          role: 'window',
          name: 'Form',
          children: [
            { role: 'textfield', name: 'Order id', ref_id: '@s:e1', states: ['readonly'], available_actions: ['Click'] },
            { role: 'combobox', name: 'City', ref_id: '@s:e2', available_actions: ['Click', 'SetValue'] },
            { role: 'textfield', name: 'Unknown', ref_id: '@s:e3', available_actions: ['Click'] },
          ],
        },
      },
      minter(),
    );
    expect(root.children?.map((node) => node.states?.readonly)).toEqual([true, false, undefined]);
  });

  it('reads a control collapsed to no width or height as hidden, but not a container with children, listed or cut off', () => {
    const { root } = projectSnapshot(
      {
        snapshot_id: 's',
        tree: {
          role: 'window',
          name: 'Form',
          bounds: { x: 0, y: 0, width: 200, height: 200 },
          children: [
            { role: 'button', name: 'Collapsed', ref_id: '@s:e1', bounds: { x: 10, y: 10, width: 0, height: 20 } },
            { role: 'button', name: 'Shown', ref_id: '@s:e2', bounds: { x: 10, y: 40, width: 80, height: 20 } },
            { role: 'group', name: 'Wrapper', bounds: { x: 0, y: 0, width: 0, height: 0 }, children: [{ role: 'button', name: 'Inside', ref_id: '@s:e3', bounds: { x: 10, y: 70, width: 80, height: 20 } }] },
            { role: 'group', name: 'Deep', bounds: { x: 0, y: 0, width: 0, height: 0 }, children_count: 3 },
          ],
        },
      },
      minter(),
    );
    const byName = (name: string) => all(root).find((node) => node.name === name);
    expect(byName('Collapsed')?.states?.hidden).toBe(true);
    expect(byName('Shown')?.states?.hidden).toBeUndefined();
    expect(byName('Wrapper')?.states?.hidden).toBeUndefined();
    expect(byName('Deep')?.states?.hidden).toBeUndefined();
    expect(byName('Inside')?.states?.hidden).toBeUndefined();
  });

  it('reads everything under a hidden node as hidden, under a wrapper it leaves out too, and swipes none of it', () => {
    const pane = (name: string, ref: string) => ({ role: 'scrollarea', name, ref_id: ref, available_actions: ['Scroll'], children: [{ role: 'button', name: `${name} item`, ref_id: `${ref}b` }] });
    const screen = projectSnapshot(
      {
        snapshot_id: 's',
        tree: {
          role: 'window',
          name: 'Panes',
          children: [
            { role: 'group', states: ['hidden'], children: [pane('Drawer', '@s:e1')] },
            { role: 'group', name: 'Panel', states: ['hidden'], children: [{ role: 'button', name: 'Panel item', ref_id: '@s:e3' }] },
            pane('Main', '@s:e2'),
          ],
        },
      },
      minter(),
    );
    const byName = (name: string) => all(screen.root).find((node) => node.name === name);
    for (const name of ['Drawer', 'Drawer item', 'Panel', 'Panel item']) expect(byName(name)?.states?.hidden).toBe(true);
    expect(byName('Main')?.states?.hidden).toBeUndefined();
    expect(byName('Main item')?.states?.hidden).toBeUndefined();
    expect(screen.scrollTarget).toBe(byName('Main')?.ref.id);
  });

  it('reads every node of a minimized window as hidden, the window itself too', () => {
    const { root } = projectSnapshot(load('macos/sign-in-form'), minter(), { minimized: true });
    expect(resolveExpression({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'window', exact: true }, visible: true } }, [root])).toEqual([]);
    expect(all(root).every((node) => node.states?.hidden === true)).toBe(true);
  });

  it("takes the window's title from its accessibility root, not the window list's app name", () => {
    const screen = projectSnapshot({ snapshot_id: 's', window: { id: 'w-1', title: 'SignInForm' }, tree: { role: 'window', name: 'Sign In', children: [] } }, minter());
    expect(screen.title).toBe('Sign In');
    expect(projectSnapshot({ snapshot_id: 's', window: { id: 'w-1', title: 'Untitled' }, tree: { role: 'window', children: [] } }, minter()).title).toBe('Untitled');
  });

  it('swipes the first visible, enabled node agent-desktop offers Scroll, past a list or table that cannot scroll', () => {
    const screen = projectSnapshot(
      {
        snapshot_id: 's',
        tree: {
          role: 'window',
          name: 'Feed',
          children: [
            { role: 'table', name: 'Filters', ref_id: '@s:e1', available_actions: ['Select'] },
            { role: 'list', name: 'Sidebar', ref_id: '@s:e2', available_actions: ['Select'] },
            { role: 'scrollarea', name: 'Drawer', ref_id: '@s:e3', states: ['offscreen'], available_actions: ['Scroll'] },
            { role: 'scrollarea', name: 'Archive', ref_id: '@s:e4', states: ['disabled'], available_actions: ['Scroll'] },
            { role: 'group', name: 'Posts', ref_id: '@s:e5', available_actions: ['Scroll'] },
          ],
        },
      },
      minter(),
    );
    expect(screen.scrollTarget).toBe(screen.root.children?.[4]?.ref.id);
  });

  it('counts a node with children it did not list as a cut-short tree', () => {
    const screen = projectSnapshot({ snapshot_id: 's', complete: true, tree: { role: 'window', name: 'W', children: [{ role: 'group', name: 'Deep', children_count: 3 }] } }, minter());
    expect(screen.truncated).toBe(true);
  });

  it('reads a placeholder from its own field, not from a hint', () => {
    const { root } = projectSnapshot({ snapshot_id: 's', tree: { role: 'window', name: 'W', children: [{ role: 'textfield', name: 'Email', placeholder: 'Email address', hint: 'column 1 of 2', ref_id: '@s:e1' }] } }, minter());
    expect(root.children?.[0]?.attributes).toMatchObject({ placeholder: 'Email address', hint: 'column 1 of 2' });
  });

  it('keeps ids for siblings that share a developer id but not a name', () => {
    const mint = minter();
    const ids = (screen: ReturnType<typeof projectSnapshot>) => all(screen.root).filter((node) => node.role === 'menuitem').map((node) => node.ref.id);
    const item = (name: string, index: number) => ({ role: 'menuitem', name, native_id: { kind: 'ax_identifier', value: 'menuItemSelected:' }, ref_id: `@m:e${index}`, available_actions: ['Click'] });
    const menu: RawSnapshot = { snapshot_id: 'm', tree: { role: 'menu', children: [item('Free', 1), item('Pro', 2), item('Team', 3)] } };
    const first = ids(projectSnapshot(menu, mint));
    const second = ids(projectSnapshot(menu, mint));
    expect(new Set(first).size).toBe(3);
    expect(second).toEqual(first);
  });

  it('keeps a status its id while its text changes', () => {
    const mint = minter();
    const status = (text: string): RawSnapshot => ({ snapshot_id: 's', tree: { role: 'window', name: 'W', children: [{ role: 'statictext', value: text, native_id: { kind: 'ax_identifier', value: 'status' } }] } });
    expect(projectSnapshot(status('Not signed in'), mint).root.children?.[0]?.ref.id).toBe(projectSnapshot(status('Signed in'), mint).root.children?.[0]?.ref.id);
  });

  it('never lets a developer id and a name spell another control\'s identity', () => {
    const raw: RawSnapshot = {
      snapshot_id: 's',
      tree: {
        role: 'window',
        name: 'W',
        children: [
          { role: 'button', name: 'Edit:', native_id: { kind: 'ax_identifier', value: 'shared' }, ref_id: '@s:e1' },
          { role: 'button', name: 'Copy', native_id: { kind: 'ax_identifier', value: 'shared' }, ref_id: '@s:e2' },
          { role: 'button', name: 'Archived', native_id: { kind: 'ax_identifier', value: 'shared:Edit' }, ref_id: '@s:e3' },
        ],
      },
    };
    const ids = projectSnapshot(raw, minter()).root.children!.map((node) => node.ref.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('keeps a secure field a wrapper would hide, so its bounds are masked', () => {
    const screen = projectSnapshot(
      { snapshot_id: 's', tree: { role: 'window', name: 'W', bounds: { x: 0, y: 0, width: 100, height: 100 }, children: [{ role: 'group', states: ['secure'], bounds: { x: 10, y: 10, width: 50, height: 20 } }] } },
      minter(),
    );
    expect(screen.secureRects).toEqual([{ x: 10, y: 10, width: 50, height: 20 }]);
  });

  it('withholds masking for a secure field whose box has no area', () => {
    const screen = projectSnapshot({ snapshot_id: 's', tree: { role: 'window', name: 'W', bounds: { x: 0, y: 0, width: 100, height: 100 }, children: [{ role: 'textfield', states: ['secure'], ref_id: '@s:e1', bounds: { x: 10, y: 10, width: 0, height: 0 } }] } }, minter());
    expect(screen.secureRects).toBeUndefined();
  });

  it('gives a control its title as its text, and an input none', () => {
    const { root } = project('macos/sign-in-form');
    expect(byTestId(root, 'sign-in')).toMatchObject({ name: 'Sign in', text: 'Sign in' });
    expect(byTestId(root, 'username')?.text).toBeUndefined();
  });

  it('withholds masking when a secure field has no bounds, and measures rects from the window', () => {
    expect(project('macos/appkit-form').secureRects).toBeUndefined();
    const raw = load('macos/appkit-form');
    const bounded: RawSnapshot = {
      ...raw,
      tree: {
        ...raw.tree,
        bounds: { x: 100, y: 50, width: 400, height: 300 },
        children: raw.tree.children!.map((child) => ({ ...child, bounds: { x: 120, y: 90, width: 260, height: 22 } })),
      },
    };
    const screen = projectSnapshot(bounded, minter());
    expect(screen.viewport).toEqual({ width: 400, height: 300 });
    expect(screen.secureRects).toEqual([{ x: 20, y: 40, width: 260, height: 22 }]);
  });

  it('measures every rect from the window on a real capture', () => {
    const screen = project('macos/sign-in-form');
    expect(screen.viewport).toEqual({ width: 420, height: 352 });
    expect(screen.secureRects).toEqual([{ x: 19, y: 110, width: 262, height: 26 }]);
    expect(screen.windowId).toBeDefined();
    expect(byTestId(screen.root, 'status')).toMatchObject({ role: 'text', name: 'Not signed in', text: 'Not signed in', rect: { x: 19, y: 230 } });
  });
});
