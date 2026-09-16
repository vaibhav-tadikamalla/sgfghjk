import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import { CollaborationCursorCustom } from '@/extensions/collaborationCursor';
import Placeholder from '@tiptap/extension-placeholder';
import Highlight from '@tiptap/extension-highlight';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import TextAlign from '@tiptap/extension-text-align';
import Underline from '@tiptap/extension-underline';
import { useCollaboration } from '@/hooks/useCollaboration';
import { useKeystrokeTracker, type KeystrokeStats } from '@/hooks/useKeystrokeTracker';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useAuth } from '@/lib/auth/AuthContext';
import { EditorToolbar } from './EditorToolbar';
import { ActiveUsers } from './ActiveUsers';
import { HistoryPanel } from './history/HistoryPanel';
import { CommentMark } from '@/extensions/commentMark';
import { CommentSidebar } from './comments/CommentSidebar';
import { AddCommentButton } from './comments/AddCommentButton';
import { useCommentStore } from '@/stores/commentStore';
import { api } from '@/lib/api';

export function FileEditor() {
  const { activeFile, activeFolder, loadContributors, loadFileActivity } = useWorkspaceStore();
  const { user } = useAuth();

  const { ydoc, awareness, status, connectedUsers, userColor, permissionError } = useCollaboration({
    fileId: activeFile?.id ?? null,
    userName: user?.displayName ?? 'Anonymous',
  });

  // Load contributors on file change
  useEffect(() => {
    if (activeFile?.id) {
      void loadContributors(activeFile.id);
    }
  }, [activeFile?.id, loadContributors]);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          undoRedo: false, // Yjs handles undo/redo via Collaboration extension
        }),
        Collaboration.configure({
          document: ydoc,
        }),
        CollaborationCursorCustom.configure({
          awareness,
          user: {
            name: user?.displayName ?? 'Anonymous',
            color: userColor,
          },
        }),
        Placeholder.configure({
          placeholder: 'Start writing…',
        }),
        Highlight.configure({ multicolor: true }),
        TaskList,
        TaskItem.configure({ nested: true }),
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        Underline,
        CommentMark,
      ],
      editorProps: {
        attributes: {
          class: 'focus:outline-none min-h-[calc(100vh-8rem)]',
        },
      },
    },
    [activeFile?.id],
  );

  const isReadOnly = activeFolder?.role === 'viewer';

  // --- Keystroke velocity tracker (copy-paste detection) ---
  const keystrokeStats = useKeystrokeTracker(editor);
  const lastReportedPasteCountRef = useRef(0);
  const resetKeystrokeTracker = keystrokeStats.reset;

  // Reset tracker when file changes
  useEffect(() => {
    resetKeystrokeTracker();
    lastReportedPasteCountRef.current = 0;
  }, [activeFile?.id, resetKeystrokeTracker]);

  // Report paste-count deltas to the active edit session for admin reviewer analytics.
  useEffect(() => {
    if (!activeFile?.id || isReadOnly) return;

    const currentPasteCount = keystrokeStats.pasteCount;
    const alreadyReported = lastReportedPasteCountRef.current;
    if (currentPasteCount <= alreadyReported) return;

    const delta = currentPasteCount - alreadyReported;
    lastReportedPasteCountRef.current = currentPasteCount;

    void api.post(`api/files/${activeFile.id}/session/paste`, {
      json: { count: delta },
    }).catch(() => {
      // Best-effort telemetry; skip retries to avoid extra write pressure.
    });
  }, [activeFile?.id, isReadOnly, keystrokeStats.pasteCount]);

  const [historyOpen, setHistoryOpen] = useState(false);
  const { sidebarOpen: commentSidebarOpen, toggleSidebar: toggleCommentSidebar } = useCommentStore();

  useEffect(() => {
    if (editor && isReadOnly) {
      editor.setEditable(false);
    } else if (editor) {
      editor.setEditable(true);
    }
  }, [editor, isReadOnly]);

  if (!activeFile) return null;

  return (
    <div className="flex flex-col h-full relative">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-surface-1">
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-medium text-text-primary truncate">{activeFile.name}</h2>
          {activeFile.editorName && (
            <p className="text-[11px] text-text-muted">
              Last edited by {activeFile.editorName}
            </p>
          )}
        </div>

        {/* Keystroke velocity badge — copy-paste detection */}
        <KeystrokeIndicator stats={keystrokeStats} />

        <ActiveUsers users={connectedUsers} />

        <ConnectionIndicator status={status} />

        {/* History button — always visible regardless of role */}
        <button
          onClick={() => setHistoryOpen((v) => !v)}
          title="Document History"
          className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors ${
            historyOpen
              ? 'bg-accent text-white'
              : 'text-text-muted hover:text-text-primary hover:bg-surface-3'
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </button>

        {/* Comments button — always visible regardless of role */}
        <button
          onClick={toggleCommentSidebar}
          title="Comments"
          className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors ${
            commentSidebarOpen
              ? 'bg-accent text-white'
              : 'text-text-muted hover:text-text-primary hover:bg-surface-3'
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </button>

        {isReadOnly && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 font-medium">
            Read-only
          </span>
        )}
      </div>

      {/* Toolbar */}
      {editor && !isReadOnly && (
        <EditorToolbar editor={editor} onHistory={() => setHistoryOpen(true)} onComments={toggleCommentSidebar} />
      )}

      {/* Permission error banner */}
      {permissionError && (
        <div className="px-4 py-2 bg-red-500/10 border-b border-red-500/20 text-red-400 text-xs font-medium">
          {permissionError}
        </div>
      )}

      {/* Editor */}
      <div className="flex-1 overflow-y-auto">
        <div className="tiptap-wrapper max-w-3xl mx-auto px-6 py-4">
          <EditorContent editor={editor} />
        </div>
      </div>

      {/* Document History panel */}
      {historyOpen && activeFile?.id && (
        <HistoryPanel
          fileId={activeFile.id}
          canWrite={!isReadOnly}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      {/* Floating Add Comment button (visible on text selection) */}
      {editor && !isReadOnly && activeFile?.id && (
        <AddCommentButton editor={editor} fileId={activeFile.id} />
      )}

      {/* Comment threads sidebar */}
      {commentSidebarOpen && activeFile?.id && (
        <CommentSidebar
          fileId={activeFile.id}
          editor={editor}
          canWrite={!isReadOnly}
        />
      )}
    </div>
  );
}

function ConnectionIndicator({ status }: { status: string }) {
  const colors: Record<string, string> = {
    connected: 'bg-green-500',
    connecting: 'bg-yellow-500 animate-pulse',
    disconnected: 'bg-gray-500',
    error: 'bg-red-500',
  };

  return (
    <div className="flex items-center gap-1.5" title={`Connection: ${status}`}>
      <div className={`w-2 h-2 rounded-full ${colors[status] ?? 'bg-gray-500'}`} />
      <span className="text-[11px] text-text-muted capitalize">{status}</span>
    </div>
  );
}

function KeystrokeIndicator({ stats }: { stats: KeystrokeStats }) {
  const [expanded, setExpanded] = React.useState(false);
  const {
    maxCharsPerSecond,
    currentCharsPerSecond,
    pasteDetected,
    pasteCount,
    totalPastedChars,
    suspiciousBurst,
  } = stats;

  // Don't render until there's any activity
  if (maxCharsPerSecond === 0 && !pasteDetected) return null;

  // Thresholds: 0-12 normal, 13-20 fast, >20 suspicious
  const MAX_DISPLAY_CPS = 30;
  const liveBarPct  = Math.min((currentCharsPerSecond / MAX_DISPLAY_CPS) * 100, 100);
  const peakBarPct  = Math.min((maxCharsPerSecond    / MAX_DISPLAY_CPS) * 100, 100);

  // Determine severity
  const isBurst   = suspiciousBurst || pasteDetected;
  const isFast    = !isBurst && maxCharsPerSecond > 12;
  const isNormal  = !isBurst && !isFast;

  // Design tokens per severity
  const tokens = isBurst
    ? { bg: 'bg-red-500/10',    border: 'border-red-500/30',    text: 'text-red-400',    bar: 'bg-red-500',    glow: 'animate-burst-glow', icon: '⚠', label: pasteDetected ? 'Paste Detected' : 'Burst Detected' }
    : isFast
    ? { bg: 'bg-yellow-500/10', border: 'border-yellow-500/30', text: 'text-yellow-400', bar: 'bg-yellow-400', glow: '',                  icon: '⚡', label: 'Fast Typing' }
    : { bg: 'bg-emerald-500/10',border: 'border-emerald-500/25',text: 'text-emerald-400',bar: 'bg-emerald-500',glow: '',                  icon: '⌨', label: 'Normal' };

  return (
    <div className="relative flex items-center">
      {/* Collapsed pill — always visible while there's data */}
      <button
        onClick={() => setExpanded(v => !v)}
        className={`
          flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-semibold
          transition-all duration-200 cursor-pointer select-none
          ${tokens.bg} ${tokens.border} ${tokens.text} ${tokens.glow}
          hover:brightness-125
        `}
        title="Click for typing analysis details"
      >
        <span className="text-[11px] leading-none">{tokens.icon}</span>
        <span className="tabular-nums tracking-tight">{maxCharsPerSecond}</span>
        <span className="opacity-50 font-normal">ch/s</span>
        <span className="opacity-30 mx-0.5">·</span>
        <span className="tracking-wide">{tokens.label}</span>
        {pasteCount > 0 && (
          <span className="ml-1 px-1.5 py-px rounded-full bg-red-500/25 text-red-300 text-[9px] font-bold tracking-widest">
            {pasteCount}✕
          </span>
        )}
        {/* Tiny chevron */}
        <svg
          width="8" height="8" viewBox="0 0 8 8" fill="currentColor"
          className={`opacity-40 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
        >
          <path d="M1 2.5L4 5.5L7 2.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
        </svg>
      </button>

      {/* Expanded panel — drops below the top bar */}
      {expanded && (
        <div
          className={`
            absolute top-[calc(100%+8px)] right-0 z-50 w-72
            rounded-xl border backdrop-blur-md shadow-glass
            animate-slide-up overflow-hidden
            ${tokens.bg} ${tokens.border}
          `}
          style={{ background: 'rgba(17,17,24,0.95)' }}
        >
          {/* Panel header */}
          <div className={`px-4 py-3 border-b ${tokens.border} flex items-center justify-between`}>
            <div className="flex items-center gap-2">
              <span className="text-base leading-none">{tokens.icon}</span>
              <div>
                <p className={`text-xs font-semibold ${tokens.text}`}>Typing Analysis</p>
                <p className="text-[10px] text-text-muted">Since file was opened</p>
              </div>
            </div>
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold tracking-wide ${tokens.bg} ${tokens.border} border ${tokens.text}`}>
              {tokens.label.toUpperCase()}
            </span>
          </div>

          <div className="px-4 py-3 space-y-3">
            {/* Speed bars */}
            <div className="space-y-2">
              {/* Live speed */}
              <div>
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[10px] text-text-secondary font-medium">Live Speed</span>
                  <span className={`text-[11px] font-bold tabular-nums ${tokens.text}`}>
                    {currentCharsPerSecond} <span className="font-normal text-text-muted">ch/s</span>
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-surface-3 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${tokens.bar} opacity-70`}
                    style={{ width: `${liveBarPct}%` }}
                  />
                </div>
              </div>

              {/* Peak speed */}
              <div>
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[10px] text-text-secondary font-medium">Peak Speed</span>
                  <span className={`text-[11px] font-bold tabular-nums ${tokens.text}`}>
                    {maxCharsPerSecond} <span className="font-normal text-text-muted">ch/s</span>
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-surface-3 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${tokens.bar}`}
                    style={{ width: `${peakBarPct}%` }}
                  />
                </div>
                {/* Threshold markers */}
                <div className="flex justify-between mt-0.5 opacity-30">
                  <span className="text-[8px] text-text-muted">0</span>
                  <span className="text-[8px] text-yellow-400" style={{ marginLeft: `${(12/MAX_DISPLAY_CPS)*100}%` }}>12</span>
                  <span className="text-[8px] text-red-400">20+</span>
                </div>
              </div>
            </div>

            {/* Divider */}
            <div className="border-t border-border" />

            {/* Paste analysis */}
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold text-text-secondary uppercase tracking-widest">Paste Activity</p>

              <div className="grid grid-cols-3 gap-2">
                <div className={`rounded-lg p-2 text-center border ${pasteDetected ? 'bg-red-500/10 border-red-500/20' : 'bg-surface-3 border-border'}`}>
                  <p className={`text-base font-bold tabular-nums ${pasteDetected ? 'text-red-400' : 'text-text-primary'}`}>{pasteCount}</p>
                  <p className="text-[9px] text-text-muted leading-tight">Paste{pasteCount !== 1 ? 's' : ''}</p>
                </div>
                <div className={`rounded-lg p-2 text-center border ${totalPastedChars > 0 ? 'bg-red-500/10 border-red-500/20' : 'bg-surface-3 border-border'}`}>
                  <p className={`text-base font-bold tabular-nums ${totalPastedChars > 0 ? 'text-red-400' : 'text-text-primary'}`}>{totalPastedChars}</p>
                  <p className="text-[9px] text-text-muted leading-tight">Chars pasted</p>
                </div>
                <div className={`rounded-lg p-2 text-center border ${isBurst ? 'bg-red-500/10 border-red-500/20' : 'bg-surface-3 border-border'}`}>
                  <p className={`text-base font-bold tabular-nums ${isBurst ? 'text-red-400' : 'text-emerald-400'}`}>
                    {isBurst ? '!' : '✓'}
                  </p>
                  <p className="text-[9px] text-text-muted leading-tight">Status</p>
                </div>
              </div>
            </div>

            {/* Verdict */}
            <div className={`rounded-lg p-2.5 border text-[10px] leading-relaxed ${isBurst ? 'bg-red-500/10 border-red-500/20 text-red-300' : 'bg-surface-3 border-border text-text-secondary'}`}>
              {pasteDetected
                ? `⚠ ${pasteCount} paste event${pasteCount > 1 ? 's' : ''} detected with ${totalPastedChars} characters. Manual typing unlikely.`
                : isBurst
                ? `⚠ Peak of ${maxCharsPerSecond} ch/s exceeds human typing limit (~20 ch/s). Possible paste.`
                : isFast
                ? `⚡ Fast typing detected (${maxCharsPerSecond} ch/s). Above average but plausible.`
                : `✓ Typing pattern appears normal. No paste events detected.`
              }
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
