/**
 * unit/benchmark-propagation-tracker.test.ts
 *
 * Tests for BenchmarkPropagationTracker.ts
 * Verifies t1→t2 correlation logic without needing a live WebSocket.
 *
 * We construct minimal valid Yjs update bytes to simulate what
 * Y.decodeUpdate would process.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { BenchmarkPropagationTracker } from '../../packages/server/src/benchmark/BenchmarkPropagationTracker';

// Helper: create a real Yjs update buffer from a Y.Doc transact
function makeYjsUpdate(doc: Y.Doc, fn: () => void): Uint8Array {
  const stateBefore = Y.encodeStateVector(doc);
  fn();
  return Y.encodeStateAsUpdate(doc, stateBefore);
}

describe('BenchmarkPropagationTracker', () => {
  let tracker: BenchmarkPropagationTracker;

  beforeEach(() => {
    tracker = new BenchmarkPropagationTracker();
    tracker.activate();
  });

  afterEach(() => {
    tracker.dispose();
  });

  it('starts with empty samples', () => {
    expect(tracker.samples).toHaveLength(0);
    expect(tracker.latencySamples).toHaveLength(0);
  });

  it('does not record when inactive', () => {
    tracker.deactivate();

    const senderDoc = new Y.Doc();
    const clientId = senderDoc.clientID;
    const clock = senderDoc.store.clients.get(clientId)?.length ?? 0;

    tracker.recordSend('editor-A', clientId, clock, performance.now());
    const update = makeYjsUpdate(senderDoc, () => {
      senderDoc.getText('default').insert(0, 'hello');
    });
    tracker.recordReceive('editor-B', update, performance.now() + 5);

    expect(tracker.samples).toHaveLength(0);
  });

  it('records a latency sample when send and receive match', () => {
    const senderDoc = new Y.Doc();
    const clientId = senderDoc.clientID;
    const clockBefore = senderDoc.store.clients.get(clientId)?.length ?? 0;

    const t1 = performance.now();
    tracker.recordSend('editor-A', clientId, clockBefore, t1);

    // Actually apply the transact to get the real update bytes
    const update = makeYjsUpdate(senderDoc, () => {
      senderDoc.getText('default').insert(0, 'benchmark test text');
    });

    const t2 = t1 + 50; // simulate 50ms propagation
    tracker.recordReceive('editor-B', update, t2);

    expect(tracker.samples.length).toBeGreaterThanOrEqual(1);
    if (tracker.samples.length > 0) {
      expect(tracker.samples[0]!.latencyMs).toBeCloseTo(50, 0);
      expect(tracker.samples[0]!.senderEditorId).toBe('editor-A');
      expect(tracker.samples[0]!.receiverEditorId).toBe('editor-B');
    }
  });

  it('latencySamples returns all latency values', () => {
    // Use two separate Y.Doc instances (different clientIDs) to simulate
    // two distinct editors sending independent updates.
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    // First send from docA
    const clientIdA = docA.clientID;
    const clockA = docA.store.clients.get(clientIdA)?.length ?? 0;
    const t1_A = performance.now();
    tracker.recordSend('editor-A', clientIdA, clockA, t1_A);
    const updateA = makeYjsUpdate(docA, () => { docA.getText('default').insert(0, 'hello'); });
    tracker.recordReceive('editor-C', updateA, t1_A + 30);

    // Second send from docB (different clientID → no key collision)
    const clientIdB = docB.clientID;
    const clockB = docB.store.clients.get(clientIdB)?.length ?? 0;
    const t1_B = performance.now();
    tracker.recordSend('editor-B', clientIdB, clockB, t1_B);
    const updateB = makeYjsUpdate(docB, () => { docB.getText('default').insert(0, 'world'); });
    tracker.recordReceive('editor-C', updateB, t1_B + 45);

    expect(tracker.latencySamples.length).toBeGreaterThanOrEqual(2);
  });

  it('does not count a received update as a sample if no matching send', () => {
    const foreignDoc = new Y.Doc();
    const update = makeYjsUpdate(foreignDoc, () => {
      foreignDoc.getText('default').insert(0, 'foreign content');
    });

    tracker.recordReceive('editor-B', update, performance.now());
    // receivedTotal should increment
    expect(tracker.receivedTotal).toBe(1);
    // But samples should be empty (no matching send was recorded)
    expect(tracker.samples).toHaveLength(0);
  });

  it('reset() clears all state', () => {
    const doc = new Y.Doc();
    const clientId = doc.clientID;
    const clock = doc.store.clients.get(clientId)?.length ?? 0;
    tracker.recordSend('A', clientId, clock, performance.now());

    tracker.reset();

    expect(tracker.samples).toHaveLength(0);
    expect(tracker.pendingCount).toBe(0);
    expect(tracker.timedOutCount).toBe(0);
  });
});
