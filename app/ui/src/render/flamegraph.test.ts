import { describe, expect, it } from 'vitest';
import type { FlameNode } from '../api/client';
import { findPath, frameColor, layoutFlame, layoutFlameWithAncestors, rectAt } from './flamegraph';

function node(frame: number | null, samples: number, children: FlameNode[] = []): FlameNode {
  return { frame, samples, children };
}

describe('layoutFlame', () => {
  it('lays out the synthetic root as two children spanning the full width', () => {
    const root = node(null, 10, [node(0, 6), node(1, 4)]);
    const rects = layoutFlame(root);

    expect(rects).toEqual([
      { node: root.children[0], depth: 0, x: 0, width: 0.6 },
      { node: root.children[1], depth: 0, x: 0.6, width: 0.4 },
    ]);
  });

  it('places grandchildren one row deeper, still relative to the whole', () => {
    const grandchild = node(2, 3);
    const child = node(0, 6, [grandchild]);
    const root = node(null, 6, [child]);
    const rects = layoutFlame(root);

    expect(rects).toEqual([
      { node: child, depth: 0, x: 0, width: 1 },
      { node: grandchild, depth: 1, x: 0, width: 0.5 },
    ]);
  });

  it('leaves a gap for self samples that go no deeper', () => {
    // 6 samples reach the frame; only 4 continue into a child, so 2
    // samples worth of width (1/3) has nothing stacked above it.
    const root = node(null, 6, [node(0, 6, [node(1, 4)])]);
    const rects = layoutFlame(root);

    const child = rects.find((r) => r.depth === 1);
    expect(child).toEqual({ node: root.children[0].children[0], depth: 1, x: 0, width: 4 / 6 });
  });

  it('zooming into a node makes it depth 0 at full width', () => {
    const grandchild = node(2, 3);
    const child = node(0, 6, [grandchild]);

    const zoomed = layoutFlame(child);
    expect(zoomed).toEqual([
      { node: child, depth: 0, x: 0, width: 1 },
      { node: grandchild, depth: 1, x: 0, width: 0.5 },
    ]);
  });

  it('is empty when the tree holds no sample', () => {
    expect(layoutFlame(node(null, 0))).toEqual([]);
  });
});

describe('rectAt', () => {
  const rects = layoutFlame(node(null, 10, [node(0, 6), node(1, 4)]));

  it('finds the rect covering a fraction on its row', () => {
    expect(rectAt(rects, 0, 0.3)?.node.frame).toBe(0);
    expect(rectAt(rects, 0, 0.6)?.node.frame).toBe(1);
  });

  it('treats a rect boundary as belonging to the right-hand rect', () => {
    expect(rectAt(rects, 0, 0.6)?.node.frame).toBe(1);
  });

  it('misses rows or fractions with nothing laid out', () => {
    expect(rectAt(rects, 1, 0.3)).toBeUndefined();
    expect(rectAt(rects, 0, 1)).toBeUndefined();
  });
});

describe('findPath', () => {
  it('finds the path from the root to a direct child', () => {
    const child = node(0, 6);
    const root = node(null, 10, [child, node(1, 4)]);

    expect(findPath(root, child)).toEqual([root, child]);
  });

  it('finds the path from the root to a grandchild', () => {
    const grandchild = node(2, 3);
    const child = node(0, 6, [grandchild]);
    const root = node(null, 6, [child]);

    expect(findPath(root, grandchild)).toEqual([root, child, grandchild]);
  });

  it('is the root alone when the target is the root itself', () => {
    const root = node(null, 6, [node(0, 6)]);

    expect(findPath(root, root)).toEqual([root]);
  });

  it('is undefined when the target is not in the tree', () => {
    const root = node(null, 6, [node(0, 6)]);
    const stranger = node(9, 1);

    expect(findPath(root, stranger)).toBeUndefined();
  });
});

describe('layoutFlameWithAncestors', () => {
  it('lays out the focus alone at depth 0 when it has no ancestor', () => {
    const focus = node(null, 10, [node(0, 6), node(1, 4)]);

    expect(layoutFlameWithAncestors([], focus)).toEqual(layoutFlame(focus));
  });

  it('stacks one full-width row per ancestor above the focus, in root-first order', () => {
    const grandchild = node(2, 3);
    const child = node(0, 6, [grandchild]);
    const root = node(null, 6, [child]);

    const rects = layoutFlameWithAncestors([root, child], grandchild);

    expect(rects).toEqual([
      { node: root, depth: 0, x: 0, width: 1 },
      { node: child, depth: 1, x: 0, width: 1 },
      { node: grandchild, depth: 2, x: 0, width: 1 },
    ]);
  });
});

describe('frameColor', () => {
  it('is deterministic for the same label', () => {
    expect(frameColor('java.util.HashMap.resize')).toBe(frameColor('java.util.HashMap.resize'));
  });

  it('varies across different labels', () => {
    expect(frameColor('java.util.HashMap.resize')).not.toBe(frameColor('java.lang.Thread.run'));
  });
});
