// Pure geometry of the merged-calls canvas: the focus method's callers laid
// out above it, its callees below, sharing the flamegraph's unit-space
// layout and hit-testing since the merge is the same one — just started at
// the focus frame instead of the stack's root.

import type { MergedCallTree } from '../api/client';
import { layoutFlame, type FlameRect } from './flamegraph';

export interface MergedCallRect extends FlameRect {
  /** Rows above the focus (its callers) are negative; the focus is 0. */
  depth: number;
}

/**
 * Lays out `tree`'s callers and callees around its shared focus row. The
 * two trees agree on the focus frame and its sample count — emitted once,
 * at depth 0 — so only each tree's descendants (depth >= 1) are added,
 * callers negated to grow upward from the focus.
 */
export function layoutMergedCalls(tree: MergedCallTree): MergedCallRect[] {
  const calleeRects = layoutFlame(tree.callees);
  const focus = calleeRects.find((r) => r.depth === 0);
  const rects: MergedCallRect[] = focus ? [focus] : [];

  for (const rect of layoutFlame(tree.callers)) {
    if (rect.depth > 0) rects.push({ ...rect, depth: -rect.depth });
  }
  for (const rect of calleeRects) {
    if (rect.depth > 0) rects.push(rect);
  }
  return rects;
}
