import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { createSignal } from 'solid-js';
import { FlamegraphView } from './FlamegraphView';
import type { FlameNode, ProfileSummary } from '../../api/client';
import type { ProfileStore } from '../../state/profile';

const summary: ProfileSummary = {
  sample_count: 10,
  duration_nanos: 1_000_000_000,
  threads: [],
  thread_sample_counts: [],
  frames: [
    { class_name: 'ClassA', method_name: 'methodA' },
    { class_name: 'ClassA', method_name: 'methodB' },
    { class_name: 'ClassA', method_name: 'methodC' },
  ],
};

// Three levels deep under the first child so a zoom-then-zoom-again can be
// distinguished from stepping straight back to the untouched root.
function tree(): FlameNode {
  return {
    frame: null,
    samples: 10,
    children: [
      {
        frame: 0,
        samples: 6,
        children: [{ frame: 1, samples: 6, children: [{ frame: 2, samples: 6, children: [] }] }],
      },
      { frame: 1, samples: 4, children: [] },
    ],
  };
}

// Only `flamegraph` and `selectFrame` are exercised by this view.
function flameStore(initial: FlameNode | undefined = tree()) {
  const [flamegraph, setFlamegraph] = createSignal(initial);
  const selectFrame = vi.fn();
  const store = { flamegraph, selectFrame } as unknown as ProfileStore;
  return { store, setFlamegraph, selectFrame };
}

function renderView(store: ProfileStore) {
  render(() => <FlamegraphView store={store} summary={summary} />);
  const surface = screen.getByTestId('flame-surface');
  // jsdom has no layout: give the surface a concrete geometry.
  surface.getBoundingClientRect = () =>
    ({ left: 0, width: 100, top: 0, height: 40, right: 100, bottom: 40 }) as DOMRect;
  return surface;
}

// jsdom's PointerEvent constructor drops clientX/clientY; a MouseEvent with
// the pointer event type reaches Solid's onPointer* handlers just the same.
function firePointer(target: Element, type: string, clientX: number, clientY = 5) {
  target.dispatchEvent(new MouseEvent(type, { clientX, clientY, bubbles: true }));
}

describe('FlamegraphView', () => {
  it('shows the sample count of the current selection', () => {
    const { store } = flameStore();
    renderView(store);
    expect(screen.getByText('10 samples in selection')).toBeInTheDocument();
  });

  it('shows an empty message when the selection holds no sample', () => {
    const { store } = flameStore({ frame: null, samples: 0, children: [] });
    render(() => <FlamegraphView store={store} summary={summary} />);
    expect(screen.getByText('No samples in this selection.')).toBeInTheDocument();
    expect(screen.queryByTestId('flame-surface')).not.toBeInTheDocument();
  });

  it('reports the hovered frame', () => {
    const { store } = flameStore();
    const surface = renderView(store);

    firePointer(surface, 'pointermove', 30);
    expect(screen.getByText(/ClassA\.methodA — 6 samples \(60\.0%\)/)).toBeInTheDocument();
  });

  it('clicking a frame zooms into it, and reset zoom clears it', async () => {
    const { store } = flameStore();
    const surface = renderView(store);

    firePointer(surface, 'pointermove', 80);
    firePointer(surface, 'click', 80);
    expect(screen.getByText(/zoomed into/)).toBeInTheDocument();
    expect(screen.getByText('ClassA.methodB')).toBeInTheDocument();

    screen.getByRole('button', { name: 'reset zoom' }).click();
    expect(screen.queryByText(/zoomed into/)).not.toBeInTheDocument();
  });

  it('zooming scrolls the focus to the top, and its ancestor stays reachable by scrolling back up', () => {
    const { store } = flameStore();
    const surface = renderView(store);

    firePointer(surface, 'click', 30); // zooms into ClassA.methodA (depth 0, x 0-0.6)
    expect(screen.getByText(/zoomed into/)).toBeInTheDocument();
    expect(screen.getByText('ClassA.methodA')).toBeInTheDocument();
    expect(surface.scrollTop).toBe(20); // one ancestor row (the root) above the focus

    surface.scrollTop = 0; // analyst scrolls back up to see the ancestor
    firePointer(surface, 'click', 50, 5); // clicks the now-visible root row
    expect(screen.queryByText(/zoomed into/)).not.toBeInTheDocument();
    expect(surface.scrollTop).toBe(0);
  });

  it('clicking a descendant while zoomed re-roots onto it, extending the ancestor chain', () => {
    const { store } = flameStore();
    const surface = renderView(store);

    firePointer(surface, 'click', 30); // zooms into ClassA.methodA
    expect(surface.scrollTop).toBe(20);

    firePointer(surface, 'click', 50, 25); // with that scroll, row 2 is methodA's child methodB
    expect(screen.getByText('ClassA.methodB')).toBeInTheDocument();
    expect(surface.scrollTop).toBe(40); // now two ancestors (root, methodA) above the focus
  });

  it('reset zoom returns to the untouched root even several levels deep', () => {
    const { store } = flameStore();
    const surface = renderView(store);

    firePointer(surface, 'click', 30); // zooms into ClassA.methodA
    firePointer(surface, 'click', 50, 25); // zooms into ClassA.methodB, two levels deep

    screen.getByRole('button', { name: 'reset zoom' }).click();
    expect(screen.queryByText(/zoomed into/)).not.toBeInTheDocument();
    expect(surface.scrollTop).toBe(0);
  });

  it('hovering a frame offers to view its merged calls', async () => {
    const { store, selectFrame } = flameStore();
    const surface = renderView(store);

    firePointer(surface, 'pointermove', 30);
    await userEvent.click(screen.getByRole('button', { name: 'view merged calls' }));
    expect(selectFrame).toHaveBeenCalledWith(0);
  });

  it('a fresh tree from a filter change resets the zoom', () => {
    const { store, setFlamegraph } = flameStore();
    const surface = renderView(store);

    firePointer(surface, 'pointermove', 80);
    firePointer(surface, 'click', 80);
    expect(screen.getByText(/zoomed into/)).toBeInTheDocument();

    setFlamegraph(tree());
    expect(screen.queryByText(/zoomed into/)).not.toBeInTheDocument();
  });
});
