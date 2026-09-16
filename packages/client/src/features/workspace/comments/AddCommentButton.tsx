import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { useCommentStore } from '@/stores/commentStore';
import { useAuth } from '@/lib/auth/AuthContext';

interface FloatPos {
  top: number;
  left: number;
}

interface AddCommentButtonProps {
  editor: Editor | null;
  fileId: string;
}

export function AddCommentButton({ editor, fileId }: AddCommentButtonProps) {
  const [pos, setPos] = useState<FloatPos | null>(null);
  const savedRange = useRef<{ from: number; to: number } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { setPending, openSidebar, sidebarOpen } = useCommentStore();
  const { user } = useAuth();

  // Update position whenever the selection changes
  const syncPosition = useCallback((ed: Editor) => {
    const { from, to, empty } = ed.state.selection;
    if (empty) {
      setPos(null);
      savedRange.current = null;
      return;
    }

    // Store the range so we can apply the mark after sidebar input
    savedRange.current = { from, to };

    // Use ProseMirror view coords — page-relative, safe for fixed positioning
    const startCoords = ed.view.coordsAtPos(from);
    const endCoords = ed.view.coordsAtPos(to);

    const midX = (startCoords.left + endCoords.left) / 2;
    const topY = Math.min(startCoords.top, endCoords.top) - 44;

    setPos({ left: midX, top: topY });
  }, []);

  useEffect(() => {
    if (!editor) return;

    const onSelection = ({ editor: ed }: { editor: Editor }) => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      syncPosition(ed);
    };

    const onBlur = () => {
      // Small delay so that a click on this button (which blurs the editor)
      // still lands before we hide the button.
      hideTimer.current = setTimeout(() => setPos(null), 200);
    };

    const onFocus = () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };

    editor.on('selectionUpdate', onSelection);
    editor.on('blur', onBlur);
    editor.on('focus', onFocus);

    return () => {
      editor.off('selectionUpdate', onSelection);
      editor.off('blur', onBlur);
      editor.off('focus', onFocus);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [editor, syncPosition]);

  // Adding a new comment: open sidebar with a pending thread
  const handleClick = () => {
    if (!editor || !savedRange.current) return;
    if (hideTimer.current) clearTimeout(hideTimer.current);

    const threadId = crypto.randomUUID();
    setPending({ threadId, ...savedRange.current });
    openSidebar();
    setPos(null);
  };

  if (!pos) return null;
  if (sidebarOpen) return null; // sidebar already open — don't double-prompt

  return (
    <div
      className="fixed z-50 pointer-events-auto"
      style={{
        top: pos.top,
        left: pos.left,
        transform: 'translateX(-50%)',
      }}
    >
      {/* Prevent editor blur so the selection stays intact */}
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={handleClick}
        className={
          'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg ' +
          'bg-surface-2 border border-border shadow-lg text-[11px] ' +
          'text-text-secondary hover:text-text-primary hover:bg-surface-3 ' +
          'transition-all duration-100 select-none'
        }
        title="Add comment"
      >
        <CommentIcon />
        <span className="font-medium">Comment</span>
      </button>
    </div>
  );
}

function CommentIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
