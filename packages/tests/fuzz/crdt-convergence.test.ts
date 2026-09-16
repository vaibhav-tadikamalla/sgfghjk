import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { v4 as uuid } from 'uuid';

describe('CRDT Fuzz: 5 clients × 2000 ops', () => {
  it('all replicas converge', () => {
    const N = 5, OPS = 2000;
    const docs: Y.Doc[] = [];
    const updates: Array<{ ci: number; u: Uint8Array }> = [];
    for (let c = 0; c < N; c++) {
      const d = new Y.Doc();
      d.transact(() => { const p = new Y.Map(); p.set('objects', new Y.Array()); d.getArray('pages').push([p]); });
      docs.push(d);
    }
    const base = Y.encodeStateAsUpdate(docs[0]);
    for (let c = 1; c < N; c++) Y.applyUpdate(docs[c], base);

    let seed = 42;
    const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

    for (let c = 0; c < N; c++) {
      const d = docs[c];
      const g = () => (d.getArray('pages').get(0) as Y.Map<any>).get('objects') as Y.Array<Y.Map<any>>;
      for (let i = 0; i < OPS; i++) {
        const sv = Y.encodeStateVector(d);
        try {
          d.transact(() => {
            const objs = g();
            const r = rng();
            if (objs.length === 0 || r < 0.3) {
              const o = new Y.Map(); o.set('id', uuid()); o.set('x', rng()*1000); objs.push([o]);
            } else if (r < 0.5) {
              objs.delete(Math.floor(rng() * objs.length), 1);
            } else {
              objs.get(Math.floor(rng() * objs.length)).set('x', rng()*1000);
            }
          });
        } catch { continue; }
        const u = Y.encodeStateAsUpdate(d, sv);
        if (u.byteLength > 0) updates.push({ ci: c, u });
      }
    }

    const shuffled = updates.map((x, i) => ({ x, s: rng() })).sort((a, b) => a.s - b.s).map(a => a.x);
    for (const { ci, u } of shuffled) {
      for (let c = 0; c < N; c++) {
        if (c !== ci) {
          Y.applyUpdate(docs[c], u);
        }
      }
    }

    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        if (i === j) continue;
        const update = Y.encodeStateAsUpdate(docs[i], Y.encodeStateVector(docs[j]));
        if (update.byteLength > 0) {
          Y.applyUpdate(docs[j], update);
        }
      }
    }

    const states = docs.map(d => {
      const objs = (d.getArray('pages').get(0) as Y.Map<any>).get('objects') as Y.Array<any>;
      const normalized = (objs.toJSON() as Array<{ id?: string; x?: number }>)
        .map((o) => ({ id: o.id ?? '', x: o.x ?? 0 }))
        .sort((a, b) => a.id.localeCompare(b.id));
      return JSON.stringify(normalized);
    });
    for (let c = 1; c < N; c++) expect(states[c]).toBe(states[0]);
  }, 60000);
});
