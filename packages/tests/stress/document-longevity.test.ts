import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { v4 as uuid } from 'uuid';

describe('Stress: 1-year document longevity', () => {
  it('365 days of edits with GC stays under 5MB', () => {
    const doc = new Y.Doc({ gc: true });
    doc.transact(() => { const p = new Y.Map(); p.set('objects', new Y.Array()); doc.getArray('pages').push([p]); });
    const g = () => (doc.getArray('pages').get(0) as Y.Map<any>).get('objects') as Y.Array<Y.Map<any>>;
    for (let day = 0; day < 365; day++) {
      doc.transact(() => {
        const objs = g();
        for (let i = 0; i < 10; i++) { const o = new Y.Map(); o.set('id',uuid()); o.set('x',Math.random()*1920); objs.push([o]); }
        for (let i = 0; i < 40 && objs.length > 0; i++) { objs.get(Math.floor(Math.random()*objs.length)).set('x',Math.random()*1000); }
        for (let i = 0; i < 5 && objs.length > 0; i++) { objs.delete(Math.floor(Math.random()*objs.length),1); }
      });
    }
    const size = Y.encodeStateAsUpdate(doc).byteLength;
    expect(size).toBeLessThan(5 * 1024 * 1024);
  }, 30000);
});
