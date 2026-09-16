import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { v4 as uuid } from 'uuid';

describe('Stress: 100 concurrent editors', () => {
  it('converges in under 12 seconds', () => {
    const start = performance.now();
    const base = new Y.Doc();
    base.transact(() => { const p = new Y.Map(); p.set('objects', new Y.Array()); base.getArray('pages').push([p]); });
    const baseState = Y.encodeStateAsUpdate(base);
    const all: Uint8Array[] = [];
    for (let u = 0; u < 100; u++) {
      const d = new Y.Doc(); Y.applyUpdate(d, baseState);
      const objs = (d.getArray('pages').get(0) as Y.Map<any>).get('objects') as Y.Array<Y.Map<any>>;
      for (let e = 0; e < 100; e++) {
        const sv = Y.encodeStateVector(d);
        d.transact(() => {
          if (Math.random() < 0.4 || objs.length === 0) { const o = new Y.Map(); o.set('id',uuid()); objs.push([o]); }
          else if (Math.random() < 0.3 && objs.length > 0) { objs.get(Math.floor(Math.random()*objs.length)).set('x',Math.random()*1000); }
          else if (objs.length > 0) { objs.delete(Math.floor(Math.random()*objs.length),1); }
        });
        const up = Y.encodeStateAsUpdate(d, sv);
        if (up.byteLength > 0) all.push(up);
      }
      d.destroy();
    }
    const m1 = new Y.Doc(); Y.applyUpdate(m1, baseState);
    for (const u of all) Y.applyUpdate(m1, u);
    const m2 = new Y.Doc(); Y.applyUpdate(m2, baseState);
    for (let i = all.length-1; i >= 0; i--) Y.applyUpdate(m2, all[i]);
    const g = (d: Y.Doc) => (d.getArray('pages').get(0) as Y.Map<any>).get('objects') as Y.Array<any>;
    expect(JSON.stringify(g(m1).toJSON())).toBe(JSON.stringify(g(m2).toJSON()));
    expect(performance.now() - start).toBeLessThan(12000);
  }, 20000);
});
