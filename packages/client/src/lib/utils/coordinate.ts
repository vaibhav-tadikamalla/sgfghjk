export interface Point {
  x: number;
  y: number;
}

export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

export function screenToDocument(
  screen: Point,
  viewport: Viewport,
): Point {
  return {
    x: (screen.x - viewport.x) / viewport.scale,
    y: (screen.y - viewport.y) / viewport.scale,
  };
}

export function documentToScreen(
  doc: Point,
  viewport: Viewport,
): Point {
  return {
    x: doc.x * viewport.scale + viewport.x,
    y: doc.y * viewport.scale + viewport.y,
  };
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function distance(a: Point, b: Point): number {
  return Math.sqrt(Math.pow(b.x - a.x, 2) + Math.pow(b.y - a.y, 2));
}
