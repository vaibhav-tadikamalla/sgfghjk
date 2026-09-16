import { describe, it, expect } from 'vitest';

interface Viewport { offsetX: number; offsetY: number; zoom: number; }

function screenToDocument(sx: number, sy: number, v: Viewport) {
  return { x: (sx - v.offsetX) / v.zoom, y: (sy - v.offsetY) / v.zoom };
}
function documentToScreen(dx: number, dy: number, v: Viewport) {
  return { x: dx * v.zoom + v.offsetX, y: dy * v.zoom + v.offsetY };
}

describe('Coordinate Transform', () => {
  const v: Viewport = { offsetX: 100, offsetY: 50, zoom: 2 };

  it('screen to document', () => {
    const r = screenToDocument(300, 250, v);
    expect(r.x).toBe(100);
    expect(r.y).toBe(100);
  });

  it('document to screen', () => {
    const r = documentToScreen(100, 100, v);
    expect(r.x).toBe(300);
    expect(r.y).toBe(250);
  });

  it('round-trip screen → doc → screen is identity', () => {
    const d = screenToDocument(457, 312, v);
    const s = documentToScreen(d.x, d.y, v);
    expect(Math.abs(s.x - 457)).toBeLessThan(1e-10);
    expect(Math.abs(s.y - 312)).toBeLessThan(1e-10);
  });

  it('round-trip doc → screen → doc is identity', () => {
    const s = documentToScreen(350, 720, v);
    const d = screenToDocument(s.x, s.y, v);
    expect(Math.abs(d.x - 350)).toBeLessThan(1e-10);
    expect(Math.abs(d.y - 720)).toBeLessThan(1e-10);
  });

  it('1000 round-trips preserve precision', () => {
    let x = 123.456789, y = 987.654321;
    const vv: Viewport = { offsetX: 42.5, offsetY: 99.9, zoom: 1.337 };
    for (let i = 0; i < 1000; i++) {
      const s = documentToScreen(x, y, vv);
      const d = screenToDocument(s.x, s.y, vv);
      x = d.x; y = d.y;
    }
    expect(Math.abs(x - 123.456789)).toBeLessThan(1e-6);
    expect(Math.abs(y - 987.654321)).toBeLessThan(1e-6);
  });
});
