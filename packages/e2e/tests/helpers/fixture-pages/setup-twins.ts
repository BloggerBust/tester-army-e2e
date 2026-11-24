/** Two same-named buttons with nothing around them to tell them apart, one of which the `b` variant removes. */

import type { PageRenderer } from './page.ts';

/**
 * Two "Set up" buttons side by side, with no row, card, or label that keys
 * either one, and the same status whichever is pressed: a replay that presses
 * the wrong one reaches the recorded end state. `?ids=1` gives each its own
 * test id. The `b` variant (`?variant=b`, or `FixtureApp.setVariant`) renders
 * only the second, as a screen does once the first integration is removed.
 * `?done=1` adds a lone "Done" button, a control no twin shares.
 */
function renderSetupTwins(withIds: boolean, variant: string | null, done: boolean): string {
  const button = (key: string) => `<button${withIds ? ` data-testid="setup-${key}"` : ''} onclick="press()">Set up</button>`;
  const buttons = variant === 'b' ? [button('secondary')] : [button('primary'), button('secondary')];
  return `<!doctype html>
<html>
<head><title>Integrations</title></head>
<body>
  <div>${buttons.join(' ')}${done ? ' <button onclick="press()">Done</button>' : ''}</div>
  <output role="status" aria-label="Setup">Not started</output>
  <script>
    function press() {
      document.querySelector('output').textContent = 'Setup opened';
    }
  </script>
</body>
</html>`;
}

/**
 * Two "Remove" buttons, each removing itself, and a status that counts the
 * removals: a step that presses both from one look acts on a screen its own
 * first press changed.
 */
const REMOVE_TWINS_PAGE = `<!doctype html>
<html>
<head><title>Drafts</title></head>
<body>
  <div><button onclick="removeOne(this)">Remove</button> <button onclick="removeOne(this)">Remove</button></div>
  <output role="status" aria-label="Removed">0 removed</output>
  <script>
    let removed = 0;
    function removeOne(button) {
      button.remove();
      removed += 1;
      document.querySelector('output').textContent = removed + ' removed';
    }
  </script>
</body>
</html>`;

export const SETUP_TWIN_PAGES: Record<string, PageRenderer> = {
  '/setup-twins': (_state, url) => renderSetupTwins(url.searchParams.get('ids') === '1', url.searchParams.get('variant'), url.searchParams.get('done') === '1'),
  '/remove-twins': () => REMOVE_TWINS_PAGE,
};
