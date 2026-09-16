import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

describe('Y.Doc Lifecycle', () => {
  function createDoc(count = 0): Y.Doc {
    const doc = new Y.Doc();
    doc.transact(() => {
      const pages = doc.getArray('pages');
      const page = new Y.Map();
      const objects = new Y.Array();
      for (let i = 0; i < count; i++) {
        const obj = new Y.Map();
        obj.set('id', `obj-${i}`);
        obj.set('type', 'rectangle');
        obj.set('x', Math.random() * 1000);
        obj.set('y', Math.random() * 800);
        obj.set('fill', '#cccccc');
        objects.push([obj]);
      }
      page.set('objects', objects);
      pages.push([page]);
    });
    return doc;
  }

  it('encode and decode without loss', () => {
    const d1 = createDoc(5);
    const encoded = Y.encodeStateAsUpdate(d1);
    const d2 = new Y.Doc();
    Y.applyUpdate(d2, encoded);
    const o1 = (d1.getArray('pages').get(0) as Y.Map<any>).get('objects') as Y.Array<any>;
    const o2 = (d2.getArray('pages').get(0) as Y.Map<any>).get('objects') as Y.Array<any>;
    expect(o2.length).toBe(o1.length);
  });

  it('concurrent edits to different properties merge', () => {
    const d1 = createDoc(1);
    const d2 = new Y.Doc();
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
    const g = (d: Y.Doc) => ((d.getArray('pages').get(0) as Y.Map<any>).get('objects') as Y.Array<Y.Map<any>>).get(0);
    d1.transact(() => { g(d1).set('fill', '#ff0000'); });
    d2.transact(() => { g(d2).set('x', 999); });
    Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2, Y.encodeStateVector(d1)));
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1, Y.encodeStateVector(d2)));
    expect(g(d1).get('fill')).toBe('#ff0000');
    expect(g(d1).get('x')).toBe(999);
    expect(g(d2).get('fill')).toBe('#ff0000');
    expect(g(d2).get('x')).toBe(999);
  });

  it('concurrent same-property: LWW converges regardless of order', () => {
    const d1 = new Y.Doc();
    const d2 = new Y.Doc();
    d1.transact(() => {
      const p = new Y.Map(); const o = new Y.Array(); const obj = new Y.Map();
      obj.set('id', 'o1'); obj.set('fill', '#000');
      o.push([obj]); p.set('objects', o); d1.getArray('pages').push([p]);
    });
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
    const g = (d: Y.Doc) => ((d.getArray('pages').get(0) as Y.Map<any>).get('objects') as Y.Array<Y.Map<any>>).get(0);
    d1.transact(() => { g(d1).set('fill', '#ff0000'); });
    d2.transact(() => { g(d2).set('fill', '#0000ff'); });
    const u1 = Y.encodeStateAsUpdate(d1), u2 = Y.encodeStateAsUpdate(d2);
    const a = new Y.Doc(), b = new Y.Doc();
    Y.applyUpdate(a, u1); Y.applyUpdate(a, u2);
    Y.applyUpdate(b, u2); Y.applyUpdate(b, u1);
    expect(g(a).get('fill')).toBe(g(b).get('fill'));
  });

  it('delete while editing: delete wins', () => {
    const d1 = createDoc(2);
    const d2 = new Y.Doc();
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
    const g = (d: Y.Doc) => (d.getArray('pages').get(0) as Y.Map<any>).get('objects') as Y.Array<Y.Map<any>>;
    d1.transact(() => { g(d1).delete(0, 1); });
    d2.transact(() => { g(d2).get(0).set('fill', '#ff0000'); });
    Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2, Y.encodeStateVector(d1)));
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1, Y.encodeStateVector(d2)));
    expect(g(d1).length).toBe(1);
    expect(g(d2).length).toBe(1);
  });
});
