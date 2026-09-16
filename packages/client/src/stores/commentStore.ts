import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Comment {
  id: string;
  authorName: string;
  content: string;
  createdAt: string;
}

export interface CommentThread {
  id: string;
  fileId: string;
  resolved: boolean;
  createdAt: string;
  /** Index 0 is the root comment; subsequent entries are replies. */
  comments: Comment[];
}

interface PendingThread {
  /** Pre-generated thread ID that will also be the mark attribute. */
  threadId: string;
  /** Saved editor positions so we can apply the mark after input. */
  from: number;
  to: number;
}

// ── Store ─────────────────────────────────────────────────────────────────────

interface CommentState {
  // ── Persisted ──────────────────────────────────────────────────────────────
  threads: Record<string, CommentThread>;

  // ── Ephemeral UI ───────────────────────────────────────────────────────────
  /** Thread that the sidebar is currently focused on. */
  activeThreadId: string | null;
  /** In-flight new-comment request not yet persisted to threads. */
  pending: PendingThread | null;
  /** Whether the comment sidebar is open. */
  sidebarOpen: boolean;

  // ── Actions ────────────────────────────────────────────────────────────────
  openSidebar: () => void;
  closeSidebar: () => void;
  toggleSidebar: () => void;

  setPending: (p: PendingThread | null) => void;
  setActiveThread: (id: string | null) => void;

  createThread: (
    threadId: string,
    fileId: string,
    authorName: string,
    content: string,
  ) => void;

  addReply: (threadId: string, authorName: string, content: string) => void;
  resolveThread: (threadId: string) => void;
  reopenThread: (threadId: string) => void;
  deleteThread: (threadId: string) => void;

  getThreadsForFile: (fileId: string) => CommentThread[];
}

export const useCommentStore = create<CommentState>()(
  persist(
    (set, get) => ({
      // ── State ──────────────────────────────────────────────────────────────
      threads: {},
      activeThreadId: null,
      pending: null,
      sidebarOpen: false,

      // ── Sidebar visibility ─────────────────────────────────────────────────
      openSidebar: () => set({ sidebarOpen: true }),
      closeSidebar: () => set({ sidebarOpen: false, pending: null }),
      toggleSidebar: () =>
        set((s) => ({
          sidebarOpen: !s.sidebarOpen,
          pending: s.sidebarOpen ? null : s.pending,
        })),

      // ── Ephemeral UI ───────────────────────────────────────────────────────
      setPending: (p) => set({ pending: p }),
      setActiveThread: (id) => set({ activeThreadId: id }),

      // ── CRUD ───────────────────────────────────────────────────────────────
      createThread: (threadId, fileId, authorName, content) => {
        const thread: CommentThread = {
          id: threadId,
          fileId,
          resolved: false,
          createdAt: new Date().toISOString(),
          comments: [
            {
              id: crypto.randomUUID(),
              authorName,
              content,
              createdAt: new Date().toISOString(),
            },
          ],
        };
        set((s) => ({
          threads: { ...s.threads, [threadId]: thread },
          activeThreadId: threadId,
          pending: null,
        }));
      },

      addReply: (threadId, authorName, content) => {
        set((s) => {
          const thread = s.threads[threadId];
          if (!thread) return {};
          return {
            threads: {
              ...s.threads,
              [threadId]: {
                ...thread,
                comments: [
                  ...thread.comments,
                  {
                    id: crypto.randomUUID(),
                    authorName,
                    content,
                    createdAt: new Date().toISOString(),
                  },
                ],
              },
            },
          };
        });
      },

      resolveThread: (threadId) =>
        set((s) => ({
          threads: {
            ...s.threads,
            [threadId]: { ...s.threads[threadId], resolved: true },
          },
          activeThreadId:
            s.activeThreadId === threadId ? null : s.activeThreadId,
        })),

      reopenThread: (threadId) =>
        set((s) => ({
          threads: {
            ...s.threads,
            [threadId]: { ...s.threads[threadId], resolved: false },
          },
        })),

      deleteThread: (threadId) =>
        set((s) => {
          const copy = { ...s.threads };
          delete copy[threadId];
          return {
            threads: copy,
            activeThreadId:
              s.activeThreadId === threadId ? null : s.activeThreadId,
          };
        }),

      getThreadsForFile: (fileId) =>
        Object.values(get().threads)
          .filter((t) => t.fileId === fileId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }),

    // ── Persistence config ─────────────────────────────────────────────────
    {
      name: 'peergrid-comments-v1',
      // Only persist the thread data — ephemeral UI resets on mount
      partialize: (s) => ({ threads: s.threads }),
    },
  ),
);
