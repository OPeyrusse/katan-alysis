// How every canvas view sizes its canvas: at the size it actually occupies
// on screen, backed at device resolution. A canvas stretched by CSS blurs
// what it draws and shifts its content away from where hit-testing looks
// for it — an error that grows with distance from the canvas's origin.

export interface Size {
  width: number;
  height: number;
}

/** The backing store a canvas needs to hold `size` CSS pixels at `ratio`. */
export function backingSize(size: Size, ratio: number): Size {
  return {
    width: Math.max(1, Math.round(size.width * ratio)),
    height: Math.max(1, Math.round(size.height * ratio)),
  };
}

/**
 * Sizes `canvas` to `size` CSS pixels — backing store at device
 * resolution, CSS box at exactly what gets drawn — and returns a cleared
 * context whose units are CSS pixels. Null where the environment has no 2D
 * context; the canvas is sized all the same, since its box is the geometry
 * hit-testing reads back.
 */
export function prepareCanvas(
  canvas: HTMLCanvasElement,
  size: Size,
  ratio: number = (typeof window === 'undefined' ? 1 : window.devicePixelRatio) || 1,
): CanvasRenderingContext2D | null {
  const backing = backingSize(size, ratio);
  canvas.width = backing.width;
  canvas.height = backing.height;
  canvas.style.width = `${size.width}px`;
  canvas.style.height = `${size.height}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, size.width, size.height);
  return ctx;
}
