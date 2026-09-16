import React, { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { useCommentStore } from '@/stores/commentStore';
import { useAuth } from '@/lib/auth/AuthContext';
import { COMMENT_ACTIVATE_EVENT } from '@/extensions/commentMark';
import { CommentThread } from './CommentThread';

interface CommentSidebarProps {
  fileId: string;
  editor: Editor | null;
  canWrite?: boolean;
}

export function CommentSidebar({ fileId, editor, canWrite = true }: CommentSidebarProps) {
  const {
    pending,
    setPending,
    activeThreadId,
    setActiveThread,
    closeSidebar,
    createThread,
    getThreadsForFile,
  } = useCommentStore();

  const { user } = useAuth();
  const authorName = user?.displayName ?? 'Anonymous';

  const [showResolved, setShowResolved] = useState(false);
  const [newCommentText, setNewCommentText] = useState('');
  const newCommentRef = useRef<HTMLTextAreaElement>(null);
  const threadsEndRef = useRef<HTMLDivElement>(null);

  // ── Sync active thread from editor click ─────────────────────────────────
  useEffect(() => {
    const handler = (e: Event) => {
      const { threadId } = (e as CustomEvent<{ threadId: string }>).detail;
      setActiveThread(threadId);
    };
    document.addEventListener(COMMENT_ACTIVATE_EVENT, handler);
    return () => document.removeEventListener(COMMENT_ACTIVATE_EVENT, handler);
  }, [setActiveThread]);

  // ── Auto-focus the new comment input when a pending thread arrives ────────
  useEffect(() => {
    if (pending) {
      setNewCommentText('');
      setTimeout(() => newCommentRef.current?.focus(), 40);
    }
  }, [pending?.threadId]);

  // ── Submit the new comment ────────────────────────────────────────────────
  const handleSubmit = () => {
    const text = newCommentText.trim();
    if (!text || !pending) return;

    // Apply the comment mark at the saved range
    if (editor) {
      editor
        .chain()
        .setTextSelection({ from: pending.from, to: pending.to })
        .setComment(pending.threadId)
        .run();
    }

    createThread(pending.threadId, fileId, authorName, text);
    setNewCommentText('');
  };

  const handleCancelPending = () => {
    setPending(null);
    setNewCommentText('');
  };

  // ── Derive thread list ────────────────────────────────────────────────────
  const allThreads = getThreadsForFile(fileId);
  const visibleThreads = showResolved
    ? allThreads
    : allThreads.filter((t) => !t.resolved);

  const resolvedCount = allThreads.filter((t) => t.resolved).length;

  return (
    <>
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/20 z-20"
        onClick={closeSidebar}
        aria-hidden
      />

      {/* Drawer */}
      <div
        className={
          'absolute top-0 right-0 h-full z-30 flex flex-col ' +
          'bg-surface-1 border-l border-border shadow-2xl overflow-hidden'
        }
        style={{ width: 'clamp(280px, 34vw, 420px)' }}
        role="complementary"
        aria-label="Comment threads"
      >
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <CommentIcon />
            <span className="text-sm font-semibold text-text-primary">Comments</span>
            {allThreads.length > 0 && (
              <span className="text-[10px] text-text-muted bg-surface-3 px-1.5 py-0.5 rounded-full">
                {allThreads.filter((t) => !t.resolved).length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {resolvedCount > 0 && (
              <button
                onClick={() => setShowResolved((v) => !v)}
                className="text-[11px] text-text-muted hover:text-text-primary px-2 py-1 rounded-md hover:bg-surface-3 transition-colors"
              >
                {showResolved ? 'Hide resolved' : `Show ${resolvedCount} resolved`}
              </button>
            )}
            <button
              onClick={closeSidebar}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
              aria-label="Close comments"
            >
              <XIcon />
            </button>
          </div>
        </div>

        {/* ── New comment input (pending) ─────────────────────────────────── */}
        {pending && canWrite && (
          <div className="px-3 py-3 border-b border-border bg-surface-2 flex-shrink-0">
            <p className="text-[11px] text-text-muted mb-1.5">New comment on selected text</p>
            <textarea
              ref={newCommentRef}
              placeholder="Add a comment…"
              value={newCommentText}
              onChange={(e) => setNewCommentText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
                if (e.key === 'Escape') handleCancelPending();
              }}
              rows={3}
              className={
                'w-full bg-surface-3 text-text-primary text-xs px-2.5 py-2 rounded-lg ' +
                'border border-border focus:outline-none focus:ring-1 focus:ring-accent/50 ' +
                'placeholder:text-text-muted resize-none mb-2'
              }
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={handleCancelPending}
                className="text-[11px] px-2.5 py-1 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={!newCommentText.trim()}
                className="text-[11px] px-3 py-1 rounded-md bg-accent text-white font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors"
              >
                Comment
              </button>
            </div>
          </div>
        )}

        {/* ── Thread list ─────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto">
          {visibleThreads.length === 0 && !pending ? (
            <EmptyState hasResolved={resolvedCount > 0 && !showResolved} />
          ) : (
            <div className="p-3 flex flex-col gap-2.5">
              {visibleThreads.map((thread) => (
                <CommentThread
                  key={thread.id}
                  thread={thread}
                  active={thread.id === activeThreadId}
                  onActivate={() => {
                    setActiveThread(thread.id);
                    // Scroll editor to the comment mark
                    scrollEditorToMark(editor, thread.id);
                  }}
                />
              ))}
              <div ref={threadsEndRef} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function scrollEditorToMark(editor: Editor | null, threadId: string) {
  if (!editor) return;
  try {
    const { doc, schema } = editor.state;
    const commentType = schema.marks['comment'];
    if (!commentType) return;

    let foundPos: number | null = null;
    doc.descendants((node, pos) => {
      if (foundPos !== null) return false;
      if (
        node.isInline &&
        node.marks.some(
          (m) => m.type.name === 'comment' && m.attrs.threadId === threadId,
        )
      ) {
        foundPos = pos;
        return false;
      }
    });

    if (foundPos !== null) {
      const domNode = editor.view.nodeDOM(foundPos) as HTMLElement | null;
      domNode?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  } catch {
    /* scrolling is best-effort */
  }
}

function EmptyState({ hasResolved }: { hasResolved: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div className="w-10 h-10 rounded-xl bg-surface-3 flex items-center justify-center opacity-40">
        <CommentIcon size={20} />
      </div>
      <p className="text-sm text-text-secondary">No comments yet</p>
      <p className="text-xs text-text-muted max-w-[200px] leading-relaxed">
        {hasResolved
          ? 'All comments have been resolved.'
          : 'Select text in the editor and click the Comment button to start a thread.'}
      </p>
    </div>
  );
}

function CommentIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="text-text-muted flex-shrink-0"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
