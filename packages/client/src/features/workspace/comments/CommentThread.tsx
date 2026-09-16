import React, { useRef, useState } from 'react';
import type { CommentThread as ICommentThread, Comment } from '@/stores/commentStore';
import { useCommentStore } from '@/stores/commentStore';
import { useAuth } from '@/lib/auth/AuthContext';
import { cn } from '@/lib/utils/cn';

interface CommentThreadProps {
  thread: ICommentThread;
  active: boolean;
  onActivate: () => void;
}

export function CommentThread({ thread, active, onActivate }: CommentThreadProps) {
  const { addReply, resolveThread, reopenThread, deleteThread } = useCommentStore();
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState('');
  const { user } = useAuth();
  const authorName = user?.displayName ?? 'Anonymous';

  const replyInputRef = useRef<HTMLTextAreaElement>(null);

  const rootComment = thread.comments[0];
  const replies = thread.comments.slice(1);

  const handleReply = () => {
    const text = replyText.trim();
    if (!text) return;
    addReply(thread.id, authorName, text);
    setReplyText('');
    setReplyOpen(false);
  };

  return (
    <div
      onClick={onActivate}
      className={cn(
        'rounded-xl border transition-all duration-150 cursor-pointer group',
        active
          ? 'border-accent/40 bg-surface-2 shadow-md ring-1 ring-inset ring-accent/20'
          : 'border-border bg-surface-1 hover:border-border hover:bg-surface-2',
        thread.resolved && 'opacity-50',
      )}
    >
      {/* Root comment ───────────────────────────────────────────────────── */}
      {rootComment && (
        <CommentBubble comment={rootComment} isRoot />
      )}

      {/* Resolved indicator */}
      {thread.resolved && (
        <div className="px-3 pb-2">
          <span className="text-[10px] text-text-muted italic">Resolved</span>
        </div>
      )}

      {/* Replies ─────────────────────────────────────────────────────────── */}
      {replies.length > 0 && (
        <div className="border-t border-border/50 ml-3 mr-3 pt-2 pb-1 flex flex-col gap-1.5">
          {replies.map((r) => (
            <CommentBubble key={r.id} comment={r} />
          ))}
        </div>
      )}

      {/* Reply input ─────────────────────────────────────────────────────── */}
      {!thread.resolved && active && (
        <div className="px-3 pb-3 pt-1" onClick={(e) => e.stopPropagation()}>
          {replyOpen ? (
            <div className="flex flex-col gap-1.5">
              <textarea
                ref={replyInputRef}
                autoFocus
                placeholder="Reply…"
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleReply();
                  }
                  if (e.key === 'Escape') setReplyOpen(false);
                }}
                rows={2}
                className={
                  'w-full bg-surface-3 text-text-primary text-xs px-2.5 py-1.5 rounded-lg ' +
                  'border border-border focus:outline-none focus:ring-1 focus:ring-accent/50 ' +
                  'placeholder:text-text-muted resize-none'
                }
              />
              <div className="flex gap-1.5 justify-end">
                <button
                  onClick={() => { setReplyOpen(false); setReplyText(''); }}
                  className="text-[11px] px-2 py-1 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleReply}
                  disabled={!replyText.trim()}
                  className="text-[11px] px-2.5 py-1 rounded-md bg-accent text-white font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors"
                >
                  Reply
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-1">
              <button
                onClick={(e) => { e.stopPropagation(); setReplyOpen(true); }}
                className="text-[11px] text-text-muted hover:text-text-primary transition-colors"
              >
                Reply
              </button>

              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={(e) => { e.stopPropagation(); resolveThread(thread.id); }}
                  title="Resolve thread"
                  className="w-6 h-6 flex items-center justify-center rounded-md text-text-muted hover:text-green-400 hover:bg-surface-3 transition-colors"
                >
                  <CheckIcon />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteThread(thread.id); }}
                  title="Delete thread"
                  className="w-6 h-6 flex items-center justify-center rounded-md text-text-muted hover:text-red-400 hover:bg-surface-3 transition-colors"
                >
                  <TrashIcon />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Reopen button for resolved threads ─────────────────────────────── */}
      {thread.resolved && active && (
        <div className="px-3 pb-3 pt-1" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => reopenThread(thread.id)}
            className="text-[11px] text-text-muted hover:text-text-primary transition-colors"
          >
            Reopen
          </button>
        </div>
      )}
    </div>
  );
}

// ── Comment bubble ────────────────────────────────────────────────────────────

function CommentBubble({ comment, isRoot }: { comment: Comment; isRoot?: boolean }) {
  const date = new Date(comment.createdAt);
  return (
    <div className={cn('px-3 py-2.5', !isRoot && 'py-1.5')}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-[11px] font-semibold text-text-primary leading-none">
          {comment.authorName}
        </span>
        <time
          className="text-[10px] text-text-muted tabular-nums flex-shrink-0"
          title={date.toLocaleString()}
        >
          {formatRelative(date)}
        </time>
      </div>
      <p className="text-xs text-text-secondary leading-relaxed whitespace-pre-wrap break-words">
        {comment.content}
      </p>
    </div>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

// ── Utility ───────────────────────────────────────────────────────────────────

function formatRelative(date: Date): string {
  const diff = Date.now() - date.getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
