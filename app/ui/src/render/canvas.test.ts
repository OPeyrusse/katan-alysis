import { describe, expect, it, vi } from 'vitest';
import { backingSize, prepareCanvas } from './canvas';

/** A canvas whose context records what was done to it. */
function fakeCanvas() {
  const ctx = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  const canvas = {
    width: 0,
    height: 0,
    style: {} as CSSStyleDeclaration,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
  return { canvas, ctx };
}

describe('backingSize', () => {
  it('scales to the device ratio', () => {
    expect(backingSize({ width: 300, height: 90 }, 2)).toEqual({ width: 600, height: 180 });
  });

  it('rounds to whole pixels', () => {
    expect(backingSize({ width: 100.4, height: 33.3 }, 1.5)).toEqual({ width: 151, height: 50 });
  });

  it('never collapses to nothing', () => {
    expect(backingSize({ width: 0, height: 0 }, 2)).toEqual({ width: 1, height: 1 });
  });
});

describe('prepareCanvas', () => {
  it('sizes the CSS box to what is drawn, so the canvas is never stretched', () => {
    const { canvas } = fakeCanvas();

    prepareCanvas(canvas, { width: 300, height: 90 }, 2);

    expect(canvas.style.width).toBe('300px');
    expect(canvas.style.height).toBe('90px');
    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(180);
  });

  it('hands back a cleared context that draws in CSS pixels', () => {
    const { canvas, ctx } = fakeCanvas();

    expect(prepareCanvas(canvas, { width: 300, height: 90 }, 2)).toBe(ctx);
    expect(ctx.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 300, 90);
  });

  it('sizes the canvas even without a context, since its box is what hit-testing reads', () => {
    const canvas = {
      width: 0,
      height: 0,
      style: {} as CSSStyleDeclaration,
      getContext: () => null,
    } as unknown as HTMLCanvasElement;

    expect(prepareCanvas(canvas, { width: 300, height: 90 }, 1)).toBeNull();
    expect(canvas.style.height).toBe('90px');
  });
});
