// Pure geometry of the flamegraph canvas, in unit space ([0,1]² for x,
// integer rows for depth), so it is testable without a browser and
// independent of the rendered size and of any zoom the analyst applies.
//
// A node's box always spans `samples / <the node passed in>.samples`: at
// the whole tree, that denominator is the synthetic root's total; zoomed
// into a subtree, it is that subtree's own root, so the focused frame
// fills the full width and its ancestors are simply not laid out.

import type { FlameNode } from '../api/client';

export interface FlameRect {
  node: FlameNode;
  /** Row of the frame; the synthetic root itself is never a row. */
  depth: number;
  x: number;
  width: number;
}

/**
 * Lays out `node` and its descendants left to right, widths proportional
 * to sample count. Pass the whole tree's root for the unzoomed view, or
 * any descendant to zoom: that node becomes depth 0 at full width.
 */
export function layoutFlame(node: FlameNode): FlameRect[] {
  const rects: FlameRect[] = [];
  const total = node.samples;
  if (total <= 0) return rects;

  const visit = (n: FlameNode, depth: number, x: number) => {
    if (n.frame !== null) {
      rects.push({ node: n, depth, x, width: n.samples / total });
    }
    const childDepth = n.frame !== null ? depth + 1 : depth;
    let cursor = x;
    for (const child of n.children) {
      visit(child, childDepth, cursor);
      cursor += child.samples / total;
    }
  };
  visit(node, 0, 0);
  return rects;
}

/** The rect at a given row and horizontal fraction, if any covers it. */
export function rectAt(rects: FlameRect[], depth: number, x: number): FlameRect | undefined {
  return rects.find((r) => r.depth === depth && x >= r.x && x < r.x + r.width);
}

/**
 * The chain of nodes from `root` down to `target` (inclusive of both), by
 * object identity — recursion is shown as distinct nodes per occurrence, so
 * identity, not frame index, is what makes a node unique in the tree.
 * Undefined if `target` is not reachable from `root`.
 */
export function findPath(root: FlameNode, target: FlameNode): FlameNode[] | undefined {
  if (root === target) return [root];
  for (const child of root.children) {
    const path = findPath(child, target);
    if (path) return [root, ...path];
  }
  return undefined;
}

/**
 * Lays out the focused frame and its descendants as usual, preceded by one
 * full-width row per ancestor — the call path that led to the focus, drawn
 * above it so the analyst can scroll up to see it and click back onto it.
 */
export function layoutFlameWithAncestors(ancestors: FlameNode[], focus: FlameNode): FlameRect[] {
  const ancestorRects = ancestors.map((node, depth) => ({ node, depth, x: 0, width: 1 }));
  const focusRects = layoutFlame(focus).map((r) => ({ ...r, depth: r.depth + ancestors.length }));
  return [...ancestorRects, ...focusRects];
}

/**
 * A stable color per frame label, independent of sample counts or draw
 * order so the same method keeps its color across a filter change. Warm
 * hues (0-48°) match the conventional flamegraph palette; saturation and
 * lightness vary with the hash so adjacent same-hue frames stay
 * distinguishable.
 */
export function frameColor(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash * 31 + label.charCodeAt(i)) | 0;
  }
  const unsigned = hash >>> 0;
  const hue = unsigned % 48;
  const saturation = 55 + (Math.floor(unsigned / 48) % 30);
  const lightness = 45 + (Math.floor(unsigned / 1440) % 20);
  return `hsl(${hue}deg ${saturation}% ${lightness}%)`;
}
