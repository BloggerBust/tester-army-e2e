/**
 * What `getAttribute` reads on a device node: the attributes the projection
 * carries beside the tree's own fields, read from snapshots captured on a real
 * iOS simulator and Android emulator (`captured-snapshots.test.ts` holds the
 * trees, which leave these out).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CaptureSnapshotResult } from 'agent-device';
import type { SemanticNode } from '@e2e-dev/core/engine';
import { projectSnapshot } from '../../src/nodes.ts';

const ROOT = path.join(import.meta.dirname, '../fixtures/snapshots');

/** The attributes of the node with `testId` in a captured scenario. */
function attributesOf(platform: 'ios' | 'android', scenario: string, testId: string): SemanticNode['attributes'] {
  const raw = JSON.parse(readFileSync(path.join(ROOT, platform, `${scenario}.json`), 'utf8')) as Pick<CaptureSnapshotResult, 'nodes' | 'viewport'>;
  let counter = 0;
  const projected = projectSnapshot(raw.nodes, { mintId: () => `n${(counter += 1)}`, viewport: raw.viewport });
  const node = projected.index.map((entry) => entry.node).find((candidate) => candidate.testId === testId);
  if (node === undefined) throw new Error(`no node #${testId} in ${platform}/${scenario}`);
  return node.attributes;
}

describe('device node attributes', () => {
  it('reads label, resource-id, class, and placeholder on iOS', () => {
    expect(attributesOf('ios', 'control-inventory', 'name-input')).toEqual({
      label: 'Name field',
      'resource-id': 'name-input',
      class: 'TextField',
      placeholder: 'Type your name',
    });
    expect(attributesOf('ios', 'control-inventory', 'BackButton')).toEqual({
      label: 'Benchmark Examples',
      'resource-id': 'BackButton',
      class: 'Button',
    });
  });

  it('reads the content description as label and content-desc on Android', () => {
    expect(attributesOf('android', 'control-inventory', 'name-input')).toEqual({
      label: 'Name field',
      'resource-id': 'name-input',
      class: 'android.widget.EditText',
      'content-desc': 'Name field',
      placeholder: 'Type your name',
    });
    expect(attributesOf('android', 'control-inventory', 'inventory-header')).toEqual({
      label: 'Inventory heading',
      'resource-id': 'inventory-header',
      class: 'android.view.View',
      'content-desc': 'Inventory heading',
    });
  });

  it('reads a description-only node and a plain text view on Android', () => {
    const view = { mintId: () => 'n1', viewport: { width: 400, height: 800 } };
    const icon = projectSnapshot([{ index: 0, type: 'android.widget.ImageButton', label: 'Close', text: '' }], view);
    expect(icon.roots[0]?.attributes).toEqual({ label: 'Close', class: 'android.widget.ImageButton', 'content-desc': 'Close' });
    const text = projectSnapshot([{ index: 0, type: 'android.widget.TextView', label: 'Log in' }], view);
    expect(text.roots[0]?.attributes).toEqual({ label: 'Log in', class: 'android.widget.TextView' });
    const same = projectSnapshot([{ index: 0, type: 'android.widget.Button', label: 'Save', text: 'Save' }], view);
    expect(same.roots[0]?.attributes).toEqual({ label: 'Save', class: 'android.widget.Button' });
    const hint = projectSnapshot([{ index: 0, type: 'android.widget.EditText', label: 'Type your name', hintShowing: true }], view);
    expect(hint.roots[0]?.attributes?.label).toBeUndefined();
    expect(hint.roots[0]?.attributes?.['content-desc']).toBeUndefined();
    const described = projectSnapshot([{ index: 0, type: 'android.widget.EditText', label: 'Email address', text: '', hintShowing: true }], view);
    expect(described.roots[0]?.attributes).toMatchObject({ label: 'Email address', 'content-desc': 'Email address' });
  });

  it('drops the XCUIElementType prefix and leaves out what the platform did not report', () => {
    const raw = [{ index: 0, type: 'Other' }];
    const projected = projectSnapshot(raw, { mintId: () => 'n1', viewport: { width: 400, height: 800 } });
    expect(projected.roots[0]?.attributes).toEqual({ class: 'Other' });
    const prefixed = projectSnapshot([{ index: 0, type: 'XCUIElementTypeTextField' }], { mintId: () => 'n1', viewport: { width: 400, height: 800 } });
    expect(prefixed.roots[0]?.attributes).toEqual({ class: 'TextField' });
    expect(projectSnapshot([{ index: 0 }], { mintId: () => 'n1', viewport: { width: 400, height: 800 } }).roots[0]?.attributes).toBeUndefined();
  });

  it('reads content-desc only on Android', () => {
    const view = { mintId: () => 'n1', viewport: { width: 400, height: 800 } };
    const android = projectSnapshot([{ index: 0, type: 'android.view.View', contentDescription: 'Close' }], view);
    expect(android.roots[0]?.attributes).toEqual({ label: 'Close', class: 'android.view.View', 'content-desc': 'Close' });
    const ios = projectSnapshot([{ index: 0, type: 'Button', label: 'Done', contentDescription: 'Close' }], view);
    expect(ios.roots[0]?.attributes).toEqual({ label: 'Done', class: 'Button' });
  });
});
