import { getLogger } from '../utils/logger';
import {
  edgeMirrorDocsGauge,
  edgeMirrorLagMs,
  edgeMirrorUpdatesCounter,
} from '../metrics/advancedMetrics';
import { Room } from './Room';

const DEFAULT_MIRROR_IDLE_TIMEOUT_MS = 90_000;
const DEFAULT_SWEEP_INTERVAL_MS = 15_000;

interface MirrorEntry {
  room: Room;
  readerCount: number;
  lastReadAt: number;
  lastUpdateAt: number;
}

export interface EdgeMirrorManagerOptions {
  idleTimeoutMs?: number;
  sweepIntervalMs?: number;
  onMirrorEvicted?: (fileId: string) => void;
}

/**
 * Maintains read-only edge mirror rooms on non-owner nodes.
 *
 * Mirrors are fed from Redis Streams and are kept hot while local readers are
 * connected. Idle mirrors are evicted after a timeout to bound memory.
 */
export class EdgeMirrorManager {
  private readonly mirrors = new Map<string, MirrorEntry>();
  private readonly idleTimeoutMs: number;
  private readonly onMirrorEvicted: ((fileId: string) => void) | undefined;
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(options: EdgeMirrorManagerOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_MIRROR_IDLE_TIMEOUT_MS;
    this.onMirrorEvicted = options.onMirrorEvicted;

    const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.sweepTimer = setInterval(() => {
      this.evictIdleMirrors();
    }, sweepIntervalMs);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();

    edgeMirrorDocsGauge.set(0);
  }

  get(fileId: string): Room | undefined {
    return this.mirrors.get(fileId)?.room;
  }

  has(fileId: string): boolean {
    return this.mirrors.has(fileId);
  }

  async getOrCreate(fileId: string, factory: () => Promise<Room>): Promise<Room> {
    const existing = this.mirrors.get(fileId);
    if (existing) {
      existing.lastReadAt = Date.now();
      return existing.room;
    }

    const room = await factory();
    room.activate();
    room.refreshEstimatedSize();

    this.mirrors.set(fileId, {
      room,
      readerCount: 0,
      lastReadAt: Date.now(),
      lastUpdateAt: 0,
    });

    edgeMirrorDocsGauge.set(this.mirrors.size);
    getLogger().info({ fileId, mirrors: this.mirrors.size }, 'Edge mirror created');
    return room;
  }

  addReader(fileId: string): void {
    const mirror = this.mirrors.get(fileId);
    if (!mirror) return;
    mirror.readerCount += 1;
    mirror.lastReadAt = Date.now();
  }

  removeReader(fileId: string): number {
    const mirror = this.mirrors.get(fileId);
    if (!mirror) return 0;
    mirror.readerCount = Math.max(0, mirror.readerCount - 1);
    mirror.lastReadAt = Date.now();
    return mirror.readerCount;
  }

  applyStreamUpdate(fileId: string, update: Uint8Array, publishTimestampMs?: number): void {
    const mirror = this.mirrors.get(fileId);
    if (!mirror) return;

    try {
      mirror.room.applyRemoteUpdate(update);
    } catch (err) {
      // applyRemoteUpdate already increments byzantineRejectionsCounter.
      // Log at the mirror layer so operators can correlate with stream lag.
      getLogger().warn(
        { err, fileId, updateBytes: update.byteLength },
        'Edge mirror: failed to apply stream update — update dropped',
      );
      return; // Do not update timestamps for a failed apply
    }
    mirror.lastUpdateAt = Date.now();

    edgeMirrorUpdatesCounter.inc();
    if (typeof publishTimestampMs === 'number' && Number.isFinite(publishTimestampMs)) {
      edgeMirrorLagMs.observe(Math.max(0, Date.now() - publishTimestampMs));
    }
  }

  close(): void {
    clearInterval(this.sweepTimer);
    for (const [fileId, mirror] of this.mirrors) {
      try {
        if (mirror.room.state !== 'idle' && mirror.room.state !== 'destroying') {
          mirror.room.markIdle();
        }
        mirror.room.destroy();
      } catch (err) {
        getLogger().warn({ err, fileId }, 'Edge mirror destroy failed during close');
      }
      this.onMirrorEvicted?.(fileId);
    }
    this.mirrors.clear();
    edgeMirrorDocsGauge.set(0);
  }

  private evictIdleMirrors(): void {
    const now = Date.now();

    for (const [fileId, mirror] of this.mirrors) {
      if (mirror.readerCount > 0) continue;
      if (now - mirror.lastReadAt < this.idleTimeoutMs) continue;

      try {
        if (mirror.room.state !== 'idle' && mirror.room.state !== 'destroying') {
          mirror.room.markIdle();
        }
        mirror.room.destroy();
      } catch (err) {
        getLogger().warn({ err, fileId }, 'Edge mirror eviction destroy failed');
      }

      this.mirrors.delete(fileId);
      this.onMirrorEvicted?.(fileId);
      edgeMirrorDocsGauge.set(this.mirrors.size);
      getLogger().info({ fileId, mirrors: this.mirrors.size }, 'Edge mirror evicted due to inactivity');
    }
  }
}
