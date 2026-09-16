import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

describe('Selective Collaborative Undo', () => {
  it('undoes only local user actions', () => {
    const d1 = new Y.Doc(), d2 = new Y.Doc();
    d1.transact(() => { const p = new Y.Map(); p.set('objects', new Y.Array()); d1.getArray('pages').push([p]); });
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
    const g = (d: Y.Doc) => (d.getArray('pages').get(0) as Y.Map<any>).get('objects') as Y.Array<Y.Map<any>>;
    const o1 = 'u1', o2 = 'u2';
    const um = new Y.UndoManager(g(d1), { trackedOrigins: new Set([o1]), captureTimeout: 0 });
    d1.transact(() => { const o = new Y.Map(); o.set('id','r1'); o.set('type','rect'); g(d1).push([o]); }, o1);
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1, Y.encodeStateVector(d2)));
    d2.transact(() => { const o = new Y.Map(); o.set('id','c1'); o.set('type','ellipse'); g(d2).push([o]); }, o2);
    Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2, Y.encodeStateVector(d1)));
    expect(g(d1).length).toBe(2);
    um.undo();
    expect(g(d1).length).toBe(1);
    expect(g(d1).get(0).get('type')).toBe('ellipse');
  });

  it('transact groups drag into single undo step', () => {
    const doc = new Y.Doc();
    const origin = 'u1';
    doc.transact(() => { const p = new Y.Map(); const o = new Y.Array(); const obj = new Y.Map(); obj.set('id','r'); obj.set('x',0); obj.set('y',0); o.push([obj]); p.set('objects',o); doc.getArray('pages').push([p]); }, origin);
    const objs = (doc.getArray('pages').get(0) as Y.Map<any>).get('objects') as Y.Array<Y.Map<any>>;
    const um = new Y.UndoManager(objs, { trackedOrigins: new Set([origin]), captureTimeout: 0 });
    doc.transact(() => { for(let i=1;i<=30;i++){objs.get(0).set('x',i*10);objs.get(0).set('y',i*5);} }, origin);
    expect(objs.get(0).get('x')).toBe(300);
    um.undo();
    expect(objs.get(0).get('x')).toBe(0);
  });
});
