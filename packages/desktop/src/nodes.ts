/**
 * agent-desktop's snapshot tree projected onto the contract's semantic
 * nodes. agent-desktop already speaks one closed role and state vocabulary
 * on every OS; this maps it onto the ARIA names `screen.getByRole` and the
 * agent use on every other engine, so `getByRole('textbox')` means the same
 * field in a browser, on a phone, and in a desktop app.
 */

import type { SemanticNode, ViewportSize } from '@e2e-dev/core/engine';

/** A rectangle in screen points, as agent-desktop reports bounds. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One node of an agent-desktop snapshot (`snapshot --include-bounds`). */
export interface RawNode {
  readonly ref_id?: string;
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly description?: string;
  readonly hint?: string;
  readonly placeholder?: string;
  readonly native_id?: { readonly kind: string; readonly value: string };
  readonly states?: readonly string[];
  readonly available_actions?: readonly string[];
  readonly bounds?: Rect;
  readonly subtree_truncated?: boolean;
  /** How many children the element has, when agent-desktop stopped at the depth limit and listed none of them. */
  readonly children_count?: number;
  readonly children?: readonly RawNode[];
}

/** The `data` of an agent-desktop `snapshot`. */
export interface RawSnapshot {
  readonly app?: string;
  readonly snapshot_id: string;
  readonly complete?: boolean;
  readonly truncated?: boolean;
  readonly tree: RawNode;
  readonly window?: { readonly id: string; readonly title?: string };
}

/** The observation root's id: one window, the same id across observations, as the contract requires. */
export const ROOT_ID = 'root';

/** What an action needs to know about a node, kept beside the node the harness sees. */
export interface NodeBinding {
  readonly id: string;
  /** agent-desktop's snapshot-qualified ref (`@s8f3k2p9:e3`); absent for a node it gives none, such as static text. */
  readonly ref?: string;
  readonly role?: string;
  readonly name?: string;
  readonly states: SemanticNode['states'];
  /** The actions agent-desktop says the element takes (`Click`, `SetValue`, `Expand`, ...). */
  readonly actions: readonly string[];
  /** The window the snapshot read the node in. */
  readonly windowId?: string;
  /** The node's box in the window, which finds it again where its id cannot (a look-alike's). */
  readonly rect?: Rect;
  /** Whether the id comes from the node's identity and every ancestor's, and so names it in the next snapshot too; a look-alike's, or one inside a look-alike, is new in every snapshot. */
  readonly stable: boolean;
  /**
   * How many look-alikes the node and each of its ancestors have among their
   * siblings, root first (`/1/2/1`): a look-alike found again by its role and
   * place is the same one only if no twin around it came or went.
   */
  readonly likeness: string;
  /** The developer id (`AXIdentifier`), which a look-alike found again by its place must still carry. */
  readonly testId?: string;
  /** Read with `-i`, whose ids and look-alike counts a check of the same control must read the same way to compare. */
  readonly interactive: boolean;
}

/** A snapshot as the engine keeps it: the tree the harness sees, and a binding for every node in it. */
export interface ProjectedScreen {
  readonly root: SemanticNode;
  readonly bindings: ReadonlyMap<string, NodeBinding>;
  /** The window, in screen points: the viewport every node's rect is measured from. */
  readonly window: Rect;
  readonly viewport: ViewportSize;
  /** Rects of the secure fields, in the viewport's points, for masking. Undefined when a secure field has no bounds to mask. */
  readonly secureRects: readonly Rect[] | undefined;
  readonly truncated: boolean;
  /** The read ran out of time (`complete: false`), which the next read may not; a tree cut only at its depth limit is cut the same way every time. */
  readonly cutShort: boolean;
  readonly windowId?: string;
  readonly title?: string;
  /** The first scrollable node, which the observation root's swipe scrolls. */
  readonly scrollTarget?: string;
}

/**
 * ARIA's name for each agent-desktop role that has one. A role missing here
 * keeps agent-desktop's own token: it is still one closed vocabulary, just
 * not one a browser shares.
 */
const ROLE_MAP: Readonly<Record<string, string>> = {
  alert: 'alert',
  alertdialog: 'alertdialog',
  application: 'application',
  article: 'article',
  banner: 'banner',
  button: 'button',
  cell: 'cell',
  checkbox: 'checkbox',
  column: 'columnheader',
  combobox: 'combobox',
  complementary: 'complementary',
  contentinfo: 'contentinfo',
  definition: 'definition',
  dialog: 'dialog',
  disclosure: 'button',
  document: 'document',
  form: 'form',
  grid: 'grid',
  group: 'group',
  heading: 'heading',
  image: 'image',
  incrementor: 'spinbutton',
  link: 'link',
  list: 'list',
  listbox: 'listbox',
  log: 'log',
  main: 'main',
  marquee: 'marquee',
  math: 'math',
  menu: 'menu',
  menubutton: 'button',
  menuitem: 'menuitem',
  navigation: 'navigation',
  note: 'note',
  option: 'option',
  outline: 'tree',
  paragraph: 'paragraph',
  popover: 'dialog',
  progressbar: 'progressbar',
  radiobutton: 'radio',
  radiogroup: 'radiogroup',
  region: 'region',
  row: 'row',
  scrollbar: 'scrollbar',
  search: 'search',
  separator: 'separator',
  sheet: 'dialog',
  slider: 'slider',
  statictext: 'text',
  status: 'status',
  switch: 'switch',
  tab: 'tab',
  tablist: 'tablist',
  tabpanel: 'tabpanel',
  table: 'table',
  term: 'term',
  textfield: 'textbox',
  timer: 'timer',
  toolbar: 'toolbar',
  tooltip: 'tooltip',
  treeitem: 'treeitem',
  webarea: 'document',
  window: 'window',
};

/** Roles whose checked state is a fact whenever it is not stated: an unchecked box reports no `checked`. */
const CHECKABLE_ROLES = new Set(['checkbox', 'switch', 'radiobutton']);

/** Roles whose name labels what they hold, so it is never their text. */
const INPUT_ROLES = new Set(['textfield', 'combobox', 'slider', 'incrementor', 'datefield', 'timefield', 'colorwell']);

/** Roles agent-desktop reads text into `value`, which the contract calls `text`. */
const TEXT_ROLES = new Set(['statictext', 'heading']);

const STATE_NAMES = ['focused', 'disabled', 'secure', 'expanded', 'selected', 'hidden', 'pressed'] as const;

/**
 * A label: a whitespace-only one is no label. Nothing is cut here: `locate`
 * answers single-node reads, which carry the whole value, and the harness
 * cuts what it shows the agent.
 */
function label(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

/** The names macOS gives a window's title-bar buttons, which have no title of their own. */
const WINDOW_CONTROLS = new Set(['Close', 'Minimize', 'Zoom', 'Full Screen']);

/** The largest a title-bar button is, in points: macOS draws them 14 to 16 points across. */
const WINDOW_CONTROL_SIZE = 20;

/** How far down from the window's top edge a title-bar button can reach, in points: the title bar, or a unified title bar and toolbar, is at most this tall. */
const TITLE_BAR_HEIGHT = 52;

/**
 * A window's own title-bar button: a button straight under the window, with
 * no developer id, named only for what it does to the window, the size of a
 * title-bar button, and in the window's title bar. Left out, so
 * `getByRole('button', 'Close')` finds the app's Close button and not the
 * window's; an app's own button of the same name is larger or lower in the
 * window, and one with no bounds, or in a window with none, is kept.
 */
function windowControl(raw: RawNode, window: Rect | undefined): boolean {
  const bounds = raw.bounds;
  return (
    window !== undefined &&
    raw.role === 'button' &&
    raw.native_id === undefined &&
    raw.name !== undefined &&
    WINDOW_CONTROLS.has(raw.name) &&
    label(raw.value) === undefined &&
    label(raw.description) === undefined &&
    bounds !== undefined &&
    bounds.width <= WINDOW_CONTROL_SIZE &&
    bounds.height <= WINDOW_CONTROL_SIZE &&
    bounds.y >= window.y &&
    bounds.y + bounds.height <= window.y + TITLE_BAR_HEIGHT
  );
}

/** How far apart, at most, two neighbouring title-bar buttons are, left edge to left edge, in points: macOS spaces them about 23. */
const WINDOW_CONTROL_GAP = 30;

/**
 * The window's own title-bar buttons among its direct children: each a
 * `windowControl` beside another of a different name, in one row, as macOS
 * draws Close, Minimize, and Zoom together. agent-desktop reports no subrole
 * that names them, so a lone small Close button, such as an app's own in a
 * corner of the title bar, is kept.
 */
function titleBarButtons(tree: RawNode): ReadonlySet<RawNode> {
  const candidates = (tree.children ?? []).filter((child) => windowControl(child, tree.bounds));
  const beside = (a: RawNode, b: RawNode): boolean =>
    a !== b && a.name !== b.name && a.bounds !== undefined && b.bounds !== undefined && Math.abs(a.bounds.y - b.bounds.y) <= 2 && Math.abs(a.bounds.x - b.bounds.x) <= WINDOW_CONTROL_GAP;
  return new Set(candidates.filter((candidate) => candidates.some((other) => beside(candidate, other))));
}

/** A node agent-desktop reports but nothing reads: a wrapper with no name, value, id, ref, or text of its own. */
function transparent(raw: RawNode): boolean {
  // A secure node is never dropped: its bounds are what a screenshot masks.
  if (raw.ref_id !== undefined || raw.native_id !== undefined || raw.states?.includes('secure') === true) return false;
  if (label(raw.name) !== undefined || label(raw.value) !== undefined) return false;
  return raw.role === 'group' || raw.role === 'unknown' || raw.role === 'layoutitem' || raw.role === 'matte' || raw.role === 'splitter';
}

/**
 * What makes a node the same node in the next snapshot, among its parent's
 * children: its role and its developer id, else its role and name (or, for
 * static text, its text). A field's value is not part of it, so a field
 * keeps its id while it is typed into, and a status with a developer id
 * keeps its id while its text changes. `named` adds the name to the
 * developer id, for siblings a toolkit gives one id (AppKit menu items share
 * `menuItemSelected:`).
 */
function identityOf(node: RawNode, named = false): string {
  const name = node.name ?? (TEXT_ROLES.has(node.role) ? node.value : undefined) ?? '';
  const id = node.native_id?.value;
  // A tagged tuple, so no id or name, whatever characters it holds, can spell another kind's key.
  if (id === undefined) return JSON.stringify(['name', node.role, name]);
  return JSON.stringify(named ? ['id+name', node.role, id, name] : ['id', node.role, id]);
}

/**
 * Projects one snapshot. `idFor` turns a node's identity (its parent's id,
 * and its own role and developer id or name) into the id the harness sees:
 * the caller hands out the same id for the same identity across
 * observations, so a control keeps its id for as long as it exists, as the
 * contract asks. A node with a look-alike sibling has no identity
 * (`undefined`) and gets a new id, which no later snapshot gives out again.
 * The window is always `root`.
 * Wrappers nothing reads (anonymous groups) are dropped
 * and their children lifted, so the model reads the controls, not the
 * scaffolding, and the window's title-bar buttons are left out. Every node
 * of a `minimized` window is hidden: accessibility still reads its controls,
 * but nothing of it is on screen. `interactive` marks the bindings of a read
 * agent-desktop pruned (`-i`), whose tree, and so whose ids and look-alike
 * counts, differ from a whole read's. `onLookAlike` hears each identity a
 * look-alike sibling made shared, for a caller that must retire it, keyed by
 * the id the parent held before (`priorIdOf` looks it up without handing one
 * out), since a read cut short gives that parent a fresh one.
 */
export function projectSnapshot(
  raw: RawSnapshot,
  idFor: (identity: string | undefined) => string,
  {
    minimized = false,
    interactive = false,
    onLookAlike,
    priorIdOf,
  }: { readonly minimized?: boolean; readonly interactive?: boolean; readonly onLookAlike?: (identity: string) => void; readonly priorIdOf?: (identity: string) => string | undefined } = {},
): ProjectedScreen {
  const window = raw.tree.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
  const titleBar = titleBarButtons(raw.tree);
  const bindings = new Map<string, NodeBinding>();
  const secureRects: Rect[] = [];
  let unmaskable = false;
  let scrollTarget: string | undefined;

  // `hiddenAbove`: an ancestor is hidden, a wrapper left out included, so nothing under it is on screen; the resolver reads each node's own state only.
  // `prior`: the id the node held before, which a cut gave it a fresh one in place of; look-alikes under it are reported against that id, which their identities are kept under.
  const project = (node: RawNode, id: string, stable: boolean, likeness: string, hiddenAbove: boolean, prior: string | undefined): SemanticNode => {
    const rawStates = new Set(node.states ?? []);
    const role = ROLE_MAP[node.role] ?? (node.role === 'unknown' ? undefined : node.role);
    const secure = rawStates.has('secure');
    const states: Record<string, boolean> = {};
    for (const state of STATE_NAMES) if (rawStates.has(state)) states[state] = true;
    if (rawStates.has('offscreen') || minimized || hiddenAbove) states.hidden = true;
    // A control collapsed to no width or height draws nothing, and agent-desktop will not act on it. Only a leaf: a container with no box can still hold drawn children, listed or cut off at the depth limit.
    if (id !== ROOT_ID && node.bounds !== undefined && (node.bounds.width <= 0 || node.bounds.height <= 0) && (node.children ?? []).length === 0 && (node.children_count ?? 0) === 0) states.hidden = true;
    // A mixed checkbox is neither checked nor unchecked: no state, so check() and uncheck() always reach the control.
    if (CHECKABLE_ROLES.has(node.role) && !rawStates.has('indeterminate')) states.checked = rawStates.has('checked') || node.value === '1';
    else if (rawStates.has('checked')) states.checked = true;
    if (node.role === 'combobox' || node.role === 'disclosure' || node.role === 'menubutton') {
      if (node.available_actions?.includes('Expand') === true || node.available_actions?.includes('Collapse') === true) states.expanded = rawStates.has('expanded');
    }
    // agent-desktop marks a text field whose value cannot be set `readonly`, and offers SetValue on one whose value can. A combo box takes text only when its value can be set; a pop-up menu takes none, which is not read-only, so it gets no state, as on a device.
    const settable = node.available_actions?.includes('SetValue') === true;
    if (node.role === 'textfield' && (settable || rawStates.has('readonly'))) states.readonly = !settable;
    else if (node.role === 'combobox' && settable) states.readonly = false;
    const isText = TEXT_ROLES.has(node.role);
    const name = label(node.name ?? (isText ? node.value : undefined));
    // A control shows its name (a button's title) as its text, as on a device; an input's name is a label, not what it holds.
    const text = isText ? label(node.value ?? node.name) : INPUT_ROLES.has(node.role) ? undefined : name;
    // A checkbox's value is its state ("0", "1"), already in `checked`; a secure field's is never reported.
    // agent-desktop leaves out the value of an empty text field; it is the empty string, as inputValue() reads it, so getByDisplayValue('') finds the field.
    const value = secure || isText || CHECKABLE_ROLES.has(node.role) ? undefined : node.role === 'textfield' ? (node.value ?? '') : node.value;
    const rect = node.bounds === undefined ? undefined : { x: node.bounds.x - window.x, y: node.bounds.y - window.y, width: node.bounds.width, height: node.bounds.height };
    if (secure) {
      // A box with no area masks nothing, so it proves nothing about a field that may still show.
      if (rect === undefined || rect.width <= 0 || rect.height <= 0) unmaskable = true;
      else secureRects.push(rect);
    }
    const attributes: Record<string, string> = {};
    const placeholder = label(node.placeholder);
    if (placeholder !== undefined) attributes.placeholder = placeholder;
    const hint = label(node.hint);
    if (hint !== undefined) attributes.hint = hint;
    const description = label(node.description);
    if (description !== undefined) attributes.description = description;
    if (node.native_id !== undefined) attributes['native-id-kind'] = node.native_id.kind;
    // A swipe on the window scrolls the first node agent-desktop offers Scroll, which it scrolls only then and only while visible and enabled: a list with no scroll mechanism, or a pane off screen, would refuse it.
    if (scrollTarget === undefined && node.ref_id !== undefined && node.available_actions?.includes('Scroll') === true && states.hidden !== true && states.disabled !== true) scrollTarget = id;
    bindings.set(id, {
      id,
      ...(node.ref_id === undefined ? {} : { ref: node.ref_id }),
      ...(role === undefined ? {} : { role }),
      ...(name === undefined ? {} : { name }),
      states,
      actions: node.available_actions ?? [],
      ...(raw.window === undefined ? {} : { windowId: raw.window.id }),
      ...(rect === undefined ? {} : { rect }),
      stable,
      likeness,
      interactive,
      ...(node.native_id === undefined || node.native_id.value === '' ? {} : { testId: node.native_id.value }),
    });
    const kept: RawNode[] = [];
    const underHidden = new Set<RawNode>();
    // Whether a wrapper left out had children the read cut off: its unread children are this node's, and one could be a twin of a listed one.
    let wrapperCut = false;
    const collect = (child: RawNode, throughHidden: boolean): void => {
      if (transparent(child)) {
        if (childrenCut(child)) wrapperCut = true;
        const hiddenWrapper = throughHidden || child.states?.includes('hidden') === true || child.states?.includes('offscreen') === true;
        for (const grandchild of child.children ?? []) collect(grandchild, hiddenWrapper);
      } else {
        kept.push(child);
        if (throughHidden) underHidden.add(child);
      }
    };
    for (const child of node.children ?? []) if (id !== ROOT_ID || !titleBar.has(child)) collect(child, false);
    const tally = (named: boolean): Map<string, number> => {
      const counts = new Map<string, number>();
      for (const child of kept) counts.set(identityOf(child, named), (counts.get(identityOf(child, named)) ?? 0) + 1);
      return counts;
    };
    const plain = tally(false);
    const named = tally(true);
    // Siblings sharing a developer id tell themselves apart by name. A
    // look-alike that still matches has no identity: if the first of two
    // "Delete" buttons goes, the second must not take over its id, so each
    // look-alike gets a new id every snapshot.
    // A node whose children the read cut off lists only some of them: one that looks unique may have a twin the read did not reach, so none takes an id.
    const cut = childrenCut(node) || wrapperCut;
    const children = kept.map((child) => {
      const seen = plain.get(identityOf(child)) === 1 ? identityOf(child) : named.get(identityOf(child, true)) === 1 ? identityOf(child, true) : undefined;
      const identity = cut ? undefined : seen;
      // An identity two siblings share may pass on to neither, even where their names tell them apart now.
      if (prior !== undefined && (plain.get(identityOf(child)) ?? 0) > 1) onLookAlike?.(`${prior}/${identityOf(child)}`);
      if (prior !== undefined && (named.get(identityOf(child, true)) ?? 0) > 1) onLookAlike?.(`${prior}/${identityOf(child, true)}`);
      // A child's id is built on its parent's: under a look-alike, whose id is new every snapshot, so is the child's, and no identity is kept for it.
      const childStable = stable && identity !== undefined;
      const childId = idFor(childStable ? `${id}/${identity}` : undefined);
      const childPrior = childStable ? childId : prior !== undefined && seen !== undefined ? priorIdOf?.(`${prior}/${seen}`) : undefined;
      return project(child, childId, childStable, `${likeness}/${plain.get(identityOf(child)) ?? 1}`, states.hidden === true || underHidden.has(child), childPrior);
    });
    return {
      ref: { id, revision: '' },
      ...(role === undefined ? {} : { role }),
      ...(name === undefined ? {} : { name }),
      ...(text === undefined ? {} : { text }),
      ...(value === undefined ? {} : { value }),
      ...(node.native_id === undefined || node.native_id.value === '' ? {} : { testId: node.native_id.value }),
      ...(secure ? { inputPurpose: 'password' as const } : {}),
      ...(Object.keys(states).length === 0 ? {} : { states }),
      ...(node.role === 'heading' ? headingLevel(node) : {}),
      ...(Object.keys(attributes).length === 0 ? {} : { attributes }),
      ...(rect === undefined ? {} : { rect }),
      ...(children.length === 0 ? {} : { children }),
    };
  };

  const root = project(raw.tree, ROOT_ID, true, '', false, ROOT_ID);
  const title = label(raw.tree.name) ?? label(raw.window?.title);
  return {
    root,
    bindings,
    window,
    viewport: { width: window.width, height: window.height },
    secureRects: unmaskable ? undefined : secureRects,
    truncated: raw.complete === false || raw.truncated === true || hasTruncatedSubtree(raw.tree),
    cutShort: raw.complete === false || raw.truncated === true,
    ...(raw.window === undefined ? {} : { windowId: raw.window.id }),
    // The window's accessibility root carries its title; the window list's, which agent-desktop copies here, is the app's name without Screen Recording permission.
    ...(title === undefined ? {} : { title }),
    ...(scrollTarget === undefined ? {} : { scrollTarget }),
  };
}

/** A heading's level, when agent-desktop names it in the node's description (`heading level 2`). */
function headingLevel(node: RawNode): { level?: number } {
  const match = /\blevel (\d)\b/i.exec(node.description ?? '');
  return match === null ? {} : { level: Number(match[1]) };
}

/** Whether the read listed only some of a node's children: agent-desktop flags the node, or counts more children than it listed at the depth limit. */
function childrenCut(node: RawNode): boolean {
  return node.subtree_truncated === true || (node.children_count !== undefined && node.children_count > (node.children?.length ?? 0));
}

function hasTruncatedSubtree(node: RawNode): boolean {
  return childrenCut(node) || (node.children ?? []).some(hasTruncatedSubtree);
}
