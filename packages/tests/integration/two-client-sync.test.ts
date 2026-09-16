import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

describe('Two-Client CRDT Sync', () => {
  function pair() {
    const d1 = new Y.Doc(), d2 = new Y.Doc();
    d1.transact(() => { const p = new Y.Map(); p.set('objects', new Y.Array()); p.set('name','P1'); d1.getArray('pages').push([p]); });
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
    const sync = () => {
      Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1, Y.encodeStateVector(d2)));
      Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2, Y.encodeStateVector(d1)));
    };
    const g = (d: Y.Doc) => (d.getArray('pages').get(0) as Y.Map<any>).get('objects') as Y.Array<Y.Map<any>>;
    return { d1, d2, sync, g };
  }

  it('objects created by both clients are visible to both', () => {
    const { d1, d2, sync, g } = pair();
    d1.transact(() => { const o = new Y.Map(); o.set('id','a'); g(d1).push([o]); });
    d2.transact(() => { const o = new Y.Map(); o.set('id','b'); g(d2).push([o]); });
    sync();
    expect(g(d1).length).toBe(2);
    expect(g(d2).length).toBe(2);
  });

  it('concurrent text edits at different positions merge', () => {
    const { d1, d2, sync } = pair();
    d1.transact(() => { d1.getText('t').insert(0, 'Summer Sale 2025'); });
    sync();
    d1.transact(() => { d1.getText('t').insert(0, '🔥 '); });
    d2.transact(() => { const t = d2.getText('t'); t.insert(t.length, ' — 50% Off'); });
    sync();
    expect(d1.getText('t').toString()).toBe('🔥 Summer Sale 2025 — 50% Off');
    expect(d2.getText('t').toString()).toBe('🔥 Summer Sale 2025 — 50% Off');
  });

  it('offline divergence then convergence', () => {
    const { d1, d2, g } = pair();
    d1.transact(() => { const o = new Y.Map(); o.set('id','s'); o.set('x',100); g(d1).push([o]); });
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1, Y.encodeStateVector(d2)));
    d1.transact(() => { g(d1).get(0).set('x',200); const n = new Y.Map(); n.set('id','online'); g(d1).push([n]); });
    d2.transact(() => { g(d2).get(0).set('y',500); const n = new Y.Map(); n.set('id','offline'); g(d2).push([n]); });
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1, Y.encodeStateVector(d2)));
    Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2, Y.encodeStateVector(d1)));
    expect(g(d1).length).toBe(3);
    expect(g(d2).length).toBe(3);
    const find = (d: Y.Doc, id: string) => g(d).toArray().find(o => o.get('id') === id)!;
    expect(find(d1,'s').get('x')).toBe(200);
    expect(find(d1,'s').get('y')).toBe(500);
  });
});
