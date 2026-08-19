import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { MergedCallsView } from './MergedCallsView';
import type { MergedCallTree, ProfileSummary } from '../../api/client';
import type { ProfileStore } from '../../state/profile';

const summary: ProfileSummary = {
  sample_count: 10,
  duration_nanos: 1_000_000_000,
  threads: [],
  thread_sample_counts: [],
  frames: [
    { class_name: 'ClassA', method_name: 'focusMethod' },
    { class_name: 'ClassA', method_name: 'caller' },
    { class_name: 'ClassA', method_name: 'callee' },
  ],
};

function tree(): MergedCallTree {
  return {
    focus: 0,
    callers: { frame: 0, samples: 6, children: [{ frame: 1, samples: 6, children: [] }] },
    callees: { frame: 0, samples: 6, children: [{ frame: 2, samples: 4, children: [] }] },
  };
}

// Only `selectedFrame`, `mergedCalls` and `selectFrame` are exercised here.
function mergedStore(selected: number | undefined, initial: MergedCallTree | undefined) {
  const [selectedFrame] = createSignal(selected);
  const [mergedCalls] = createSignal(initial);
  const selectFrame = vi.fn();
  const store = { selectedFrame, mergedCalls, selectFrame } as unknown as ProfileStore;
  return { store, selectFrame };
}

function renderView(store: ProfileStore) {
  render(() => <MergedCallsView store={store} summary={summary} />);
  const surface = screen.queryByTestId('merged-calls-surface');
  if (surface) {
    // jsdom has no layout: give the surface a concrete geometry.
    surface.getBoundingClientRect = () =>
      ({ left: 0, width: 100, top: 0, height: 60, right: 100, bottom: 60 }) as DOMRect;
  }
  return surface;
}

function fireClick(target: Element, clientX: number, clientY: number) {
  target.dispatchEvent(new MouseEvent('click', { clientX, clientY, bubbles: true }));
}

describe('MergedCallsView', () => {
  it('prompts to select a method before any focus is chosen', () => {
    const { store } = mergedStore(undefined, undefined);
    renderView(store);

    expect(
      screen.getByText(/Select a method from Top methods or the Flamegraph/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('merged-calls-surface')).not.toBeInTheDocument();
  });

  it('shows the focused method and its sample count', () => {
    const { store } = mergedStore(0, tree());
    renderView(store);

    const summaryLine = screen.getByText(/samples in selection/);
    expect(summaryLine).toHaveTextContent('ClassA.focusMethod');
    expect(summaryLine).toHaveTextContent('6 samples in selection');
  });

  it('shows an empty message when the focus has no sample', () => {
    const empty: MergedCallTree = {
      focus: 0,
      callers: { frame: 0, samples: 0, children: [] },
      callees: { frame: 0, samples: 0, children: [] },
    };
    const { store } = mergedStore(0, empty);
    renderView(store);

    expect(screen.getByText('No samples in this selection.')).toBeInTheDocument();
    expect(screen.queryByTestId('merged-calls-surface')).not.toBeInTheDocument();
  });

  it('clicking a caller or callee refocuses the view on it', () => {
    const { store, selectFrame } = mergedStore(0, tree());
    const surface = renderView(store)!;

    // Row layout (ROW_HEIGHT = 20): callers at y < 0 shifted to the top,
    // focus at depth 0, callees below. Two rows of callers/callees plus
    // the focus row means depth -1 sits in the first band.
    fireClick(surface, 30, 5);
    expect(selectFrame).toHaveBeenCalledWith(1);
  });

  it('clicking the focus row itself does not refocus', () => {
    const { store, selectFrame } = mergedStore(0, tree());
    const surface = renderView(store)!;

    fireClick(surface, 30, 25);
    expect(selectFrame).not.toHaveBeenCalled();
  });
});
