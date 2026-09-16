import { Room } from './Room';

// ─────────────────────────────────────────────────────────────────────────────
// Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Storage abstraction for collaborative rooms.
 *
 * A room represents one open file being edited collaboratively.
 * The store is responsible for lifecycle management: creation, lookup,
 * removal, and enumeration.  It must coalesce concurrent creation requests
 * for the same fileId so that only a single Room instance ever exists per file.
 */
export interface RoomStore {
  /**
   * Retrieve an existing room by file ID, or undefined if not present.
   */
  get(fileId: string): Room | undefined;

  /**
   * Return an existing room for `fileId`, or call `factory()` to create one.
   *
   * Concurrent calls with the same `fileId` that arrive while `factory()` is
   * running are coalesced — they all await the same in-flight promise and
   * receive the same Room instance.
   */
  getOrCreate(fileId: string, factory: () => Promise<Room>): Promise<Room>;

  /**
   * Remove the room for `fileId` from the store and return it (or undefined
   * if it was not present).  The caller is responsible for calling
   * `room.destroy()` on the returned room.
   */
  delete(fileId: string): void;

  /**
   * Iterate over all rooms currently in the store (values only).
   */
  list(): Iterable<Room>;

  /**
   * Iterate over all rooms currently in the store.
   */
  getAll(): IterableIterator<[string, Room]>;

  /** Total number of rooms currently open. */
  readonly size: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process-local, in-memory implementation of RoomStore.
 *
 * Rooms are held in a plain Map.  Concurrent `getOrCreate` calls for the same
 * fileId are serialised through a per-key lock (a Promise stored in
 * `creationLocks`) so that only a single Room is ever constructed, regardless
 * of how many WebSocket upgrade requests race for the same file.
 *
 * This implementation is intentionally single-process; switching to a
 * distributed store (e.g. backed by Redis pub/sub) would only require
 * providing an alternative RoomStore implementation.
 */
export class InMemoryRoomStore implements RoomStore {
  private readonly rooms = new Map<string, Room>();
  /**
   * Holds in-flight creation promises.  Entries are removed once the factory
   * settles (resolved or rejected).
   */
  private readonly creationLocks = new Map<string, Promise<Room>>();

  // ── RoomStore ──────────────────────────────────────────────────────────────

  get(fileId: string): Room | undefined {
    return this.rooms.get(fileId);
  }

  async getOrCreate(fileId: string, factory: () => Promise<Room>): Promise<Room> {
    // Fast path — room already exists and is not being torn down
    const existing = this.rooms.get(fileId);
    if (existing) {
      if (existing.state !== 'destroying') return existing;
      // Stale entry in destroying state — remove it so a fresh room can be created
      this.rooms.delete(fileId);
    }

    // Coalesce concurrent creation requests for the same file
    const inflight = this.creationLocks.get(fileId);
    if (inflight) return inflight;

    // This is the first caller — start the factory and record the lock
    const promise: Promise<Room> = factory()
      .then((room) => {
        this.rooms.set(fileId, room);
        return room;
      })
      .finally(() => {
        this.creationLocks.delete(fileId);
      });

    this.creationLocks.set(fileId, promise);
    return promise;
  }

  delete(fileId: string): Room | undefined {
    const room = this.rooms.get(fileId);
    this.rooms.delete(fileId);
    return room;
  }

  list(): IterableIterator<Room> {
    return this.rooms.values();
  }

  getAll(): IterableIterator<[string, Room]> {
    return this.rooms.entries();
  }

  get size(): number {
    return this.rooms.size;
  }
}
