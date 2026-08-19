import { describe, expect, it } from 'vitest';
import type { FlameNode, MergedCallTree } from '../api/client';
import { layoutMergedCalls } from './mergedCalls';

function node(frame: number | null, samples: number, children: FlameNode[] = []): FlameNode {
  return { frame, samples, children };
}

function tree(focus: number, callers: FlameNode, callees: FlameNode): MergedCallTree {
  return { focus, callers, callees };
}

describe('layoutMergedCalls', () => {
  it('emits the shared focus row once, at depth 0', () => {
    const t = tree(1, node(1, 5), node(1, 5));
    const rects = layoutMergedCalls(t);

    expect(rects).toEqual([{ node: t.callees, depth: 0, x: 0, width: 1 }]);
  });

  it('lays out callees below the focus, depths unchanged', () => {
    const callee = node(2, 5);
    const t = tree(1, node(1, 5), node(1, 5, [callee]));
    const rects = layoutMergedCalls(t);

    expect(rects).toContainEqual({ node: callee, depth: 1, x: 0, width: 1 });
  });

  it('lays out callers above the focus, depths negated', () => {
    const caller = node(0, 5);
    const t = tree(1, node(1, 5, [caller]), node(1, 5));
    const rects = layoutMergedCalls(t);

    expect(rects).toContainEqual({ node: caller, depth: -1, x: 0, width: 1 });
  });

  it('lays out grandcallers and grandcallees two rows out', () => {
    const grandcaller = node(0, 5);
    const caller = node(1, 5, [grandcaller]);
    const grandcallee = node(4, 5);
    const callee = node(3, 5, [grandcallee]);
    const t = tree(2, node(2, 5, [caller]), node(2, 5, [callee]));
    const rects = layoutMergedCalls(t);

    expect(rects).toContainEqual({ node: grandcaller, depth: -2, x: 0, width: 1 });
    expect(rects).toContainEqual({ node: grandcallee, depth: 2, x: 0, width: 1 });
  });

  it('splits width proportionally on each side independently', () => {
    const t = tree(
      0,
      node(0, 10, [node(1, 6), node(2, 4)]),
      node(0, 10, [node(3, 3), node(4, 7)]),
    );
    const rects = layoutMergedCalls(t);

    const callers = rects.filter((r) => r.depth < 0);
    const callees = rects.filter((r) => r.depth > 0);
    expect(callers.map((r) => r.width)).toEqual([0.6, 0.4]);
    expect(callees.map((r) => r.width)).toEqual([0.3, 0.7]);
  });

  it('is just the focus row when neither side has children', () => {
    const t = tree(1, node(1, 5), node(1, 5));
    expect(layoutMergedCalls(t)).toHaveLength(1);
  });
});
