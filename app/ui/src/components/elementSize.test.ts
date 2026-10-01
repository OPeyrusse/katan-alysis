import { afterEach, describe, expect, it } from 'vitest';
import { createRoot } from 'solid-js';
import { createElementSize } from './elementSize';

const fallback = { width: 600, height: 40 };

/** A div reporting a content box, the way a laid-out element would. */
function sized(width: number, height: number): HTMLDivElement {
  const element = document.createElement('div');
  Object.defineProperty(element, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(element, 'clientHeight', { value: height, configurable: true });
  return element;
}

/** A ResizeObserver stub whose observed elements can be re-measured. */
function stubResizeObserver() {
  const observers: (() => void)[] = [];
  class Stub {
    constructor(private callback: () => void) {}
    observe() {
      observers.push(this.callback);
    }
    disconnect() {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = Stub;
  return () => observers.forEach((notify) => notify());
}

afterEach(() => {
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

describe('createElementSize', () => {
  it('measures the element as soon as it is tracked', () => {
    createRoot((dispose) => {
      const [size, track] = createElementSize(fallback);
      track(sized(820, 300));
      expect(size()).toEqual({ width: 820, height: 300 });
      dispose();
    });
  });

  it('falls back where the element has no layout to report', () => {
    createRoot((dispose) => {
      const [size, track] = createElementSize(fallback);
      track(document.createElement('div'));
      expect(size()).toEqual(fallback);
      dispose();
    });
  });

  it('follows the element as it resizes', () => {
    const resize = stubResizeObserver();
    createRoot((dispose) => {
      const [size, track] = createElementSize(fallback);
      const element = sized(820, 300);
      track(element);

      Object.defineProperty(element, 'clientWidth', { value: 400, configurable: true });
      resize();

      expect(size().width).toBe(400);
      dispose();
    });
  });
});
