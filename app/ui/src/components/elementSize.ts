import { createSignal, onCleanup, type Accessor } from 'solid-js';
import type { Size } from '../render/canvas';

/**
 * The content-box size of an element, kept current as it resizes: the size
 * a canvas inside it should be drawn at. Returns the size and the `ref` to
 * hand the element. `fallback` stands in while the element cannot be
 * measured — a panel not laid out yet, or a test environment with no
 * layout at all.
 */
export function createElementSize(fallback: Size): [Accessor<Size>, (element: HTMLElement) => void] {
  const [size, setSize] = createSignal<Size>(fallback);
  let observer: ResizeObserver | undefined;
  onCleanup(() => observer?.disconnect());

  const track = (element: HTMLElement) => {
    const measure = () =>
      setSize({
        width: element.clientWidth || fallback.width,
        height: element.clientHeight || fallback.height,
      });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    observer?.disconnect();
    observer = new ResizeObserver(measure);
    observer.observe(element);
  };

  return [size, track];
}
