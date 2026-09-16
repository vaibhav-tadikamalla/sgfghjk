import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import Highlight from '@tiptap/extension-highlight';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import TextAlign from '@tiptap/extension-text-align';
import Underline from '@tiptap/extension-underline';
import { cn } from '@/lib/utils/cn';
import {
  useVersions,
  useVersionDetail,
  useRestoreVersion,
  useCreateCheckpoint,
} from './useVersionHistory';
import { TimelineSlider } from './TimelineSlider';
import type { VersionMeta } from './types';

// ── Props ─────────────────────────────────────────────────────────────────────

interface HistoryPanelProps {
  fileId: string;
  /** Hide write-gated actions (checkpoint, restore) for viewers. */
  canWrite?: boolean;
  onClose: () => void;
  /** Called after a successful restore so the editor can react. */
  onRestored?: () => void;
}

// ── Version preview ───────────────────────────────────────────────────────────
// Isolated component keyed by versionId so TipTap re-mounts for each snapshot.

interface PreviewProps {
  snapshotBase64: string;
}

function VersionPreview({ snapshotBase64 }: PreviewProps) {
  const ydoc = useMemo(() => {
    const raw = atob(snapshotBase64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

    const doc = new Y.Doc();
    // Try V2 first (compact), fall back to V1
    try {
      Y.applyUpdateV2(doc, bytes);
    } catch {
      try {
        Y.applyUpdate(doc, bytes);
      } catch {
        /* unreadable snapshot — render empty doc */
      }
    }
    return doc;
  }, [snapshotBase64]);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ undoRedo: false }),
        Collaboration.configure({ document: ydoc }),
        Highlight.configure({ multicolor: true }),
        TaskList,
        TaskItem.configure({ nested: true }),
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        Underline,
      ],
      editable: false,
      editorProps: {
        attributes: {
          class: 'focus:outline-none text-sm leading-relaxed',
        },
      },
    },
    [ydoc],
  );

  return (
    <div className="px-4 py-3 text-text-primary overflow-y-auto h-full">
      <EditorContent editor={editor} />
    </div>
  );
}

// ── Version list item ─────────────────────────────────────────────────────────

interface VersionItemProps {
  version: VersionMeta;
  selected: boolean;
  onSelect: () => void;
}

function VersionItem({ version, selected, onSelect }: VersionItemProps) {
  const date = new Date(version.createdAt);

  return (
    <button
      onClick={onSelect}
      className={cn(
        'w-full text-left px-3 py-2 rounded-lg transition-colors duration-100 group',
        selected
          ? 'bg-accent/15 ring-1 ring-inset ring-accent/30'
          : 'hover:bg-surface-3',
      )}
    >
      <div className="flex items-center justify-between gap-2 min-w-0">
        <span
          className={cn(
            'text-[11px] font-mono font-semibold flex-shrink-0',
            selected ? 'text-accent' : 'text-text-muted',
          )}
        >
          v{version.versionNum}
        </span>
        <SourceBadge source={version.source} label={version.label} />
      </div>

      <div
        className="mt-0.5 text-[11px] text-text-muted truncate"
        title={date.toLocaleString()}
      >
        {formatRelative(date)}
        {version.byteSize > 0 && (
          <span className="ml-1.5 opacity-50">{formatBytes(version.byteSize)}</span>
        )}
      </div>
    </button>
  );
}

type SourceType = 'auto' | 'manual' | 'restore';

function SourceBadge({ source, label }: { source: SourceType; label: string | null }) {
  if (label) {
    return (
      <span className="flex-1 min-w-0 text-right">
        <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-accent/20 text-accent font-medium inline-block max-w-full truncate">
          {label}
        </span>
      </span>
    );
  }

  const cfg: Record<SourceType, { text: string; cls: string }> = {
    auto:    { text: 'Auto',       cls: 'bg-surface-4 text-text-muted' },
    manual:  { text: 'Checkpoint', cls: 'bg-accent/20 text-accent' },
    restore: { text: 'Restore',    cls: 'bg-yellow-500/20 text-yellow-400' },
  };
  const { text, cls } = cfg[source] ?? cfg.auto;

  return (
    <span className={cn('px-1.5 py-0.5 text-[10px] rounded-full font-medium flex-shrink-0', cls)}>
      {text}
    </span>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function HistoryPanel({ fileId, canWrite = true, onClose, onRestored }: HistoryPanelProps) {
  const { data: listData, isLoading: listLoading } = useVersions(fileId);

  // Chronological order for the slider (index 0 = oldest, max = newest)
  const versions = useMemo(
    () => [...(listData?.versions ?? [])].reverse(),
    [listData?.versions],
  );

  const [selectedIndex, setSelectedIndex] = useState<number>(versions.length > 0 ? versions.length - 1 : 0);

  // Default to newest when versions first load; keep in bounds
  useEffect(() => {
    if (versions.length > 0) {
      setSelectedIndex(versions.length - 1);
    }
  }, [versions.length]);

  const selectedVersion = versions[selectedIndex] ?? null;
  const selectedVersionId = selectedVersion?.id ?? null;

  const { data: versionDetail, isLoading: detailLoading } = useVersionDetail(
    fileId,
    selectedVersionId,
  );

  const restoreMutation  = useRestoreVersion(fileId);
  const checkpointMutation = useCreateCheckpoint(fileId);

  // Checkpoint UI state
  const [checkpointMode,  setCheckpointMode]  = useState(false);
  const [checkpointLabel, setCheckpointLabel] = useState('');
  const checkpointInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (checkpointMode) {
      const id = setTimeout(() => checkpointInputRef.current?.focus(), 40);
      return () => clearTimeout(id);
    }
  }, [checkpointMode]);

  // Restore confirm state
  const [confirmRestore, setConfirmRestore] = useState(false);

  // Reset confirm when version changes
  useEffect(() => { setConfirmRestore(false); }, [selectedVersionId]);

  const handleRestore = async () => {
    if (!selectedVersionId) return;
    await restoreMutation.mutateAsync(selectedVersionId);
    setConfirmRestore(false);
    onRestored?.();
    onClose();
  };

  const handleCheckpoint = async () => {
    const label = checkpointLabel.trim();
    if (!label) return;
    await checkpointMutation.mutateAsync(label);
    setCheckpointLabel('');
    setCheckpointMode(false);
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/25 z-20"
        onClick={onClose}
        aria-hidden
      />

      {/* Drawer */}
      <div
        className="absolute top-0 right-0 h-full z-30 flex flex-col bg-surface-1 border-l border-border shadow-2xl overflow-hidden"
        style={{ width: 'clamp(320px, 38vw, 460px)' }}
        role="dialog"
        aria-label="Document History"
      >
        {/* ── Header ────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <ClockIcon />
            <span className="text-sm font-semibold text-text-primary">Document History</span>
            {listData && (
              <span className="text-[10px] text-text-muted bg-surface-3 px-1.5 py-0.5 rounded-full">
                {listData.total}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1">
            {canWrite && (
              <button
                onClick={() => { setCheckpointMode((v) => !v); setCheckpointLabel(''); }}
                className="btn-ghost text-[11px] py-1 px-2.5"
                title="Save a named checkpoint"
              >
                + Checkpoint
              </button>
            )}
            <button
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
              aria-label="Close history panel"
            >
              <XIcon />
            </button>
          </div>
        </div>

        {/* ── Checkpoint input ──────────────────────────────────────────── */}
        {checkpointMode && (
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface-2 flex-shrink-0">
            <input
              ref={checkpointInputRef}
              type="text"
              placeholder="Name this checkpoint…"
              value={checkpointLabel}
              onChange={(e) => setCheckpointLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCheckpoint();
                if (e.key === 'Escape') setCheckpointMode(false);
              }}
              maxLength={255}
              className="flex-1 bg-surface-3 text-text-primary text-xs px-2.5 py-1.5 rounded-lg border border-border focus:outline-none focus:ring-1 focus:ring-accent/50 placeholder:text-text-muted"
            />
            <button
              onClick={() => void handleCheckpoint()}
              disabled={!checkpointLabel.trim() || checkpointMutation.isPending}
              className="text-[11px] px-2.5 py-1.5 rounded-lg bg-accent text-white font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors"
            >
              Save
            </button>
            <button
              onClick={() => setCheckpointMode(false)}
              className="text-[11px] px-2 py-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
            >
              Cancel
            </button>
          </div>
        )}

        {/* ── Timeline slider ───────────────────────────────────────────── */}
        <TimelineSlider
          versions={versions}
          selectedIndex={selectedIndex}
          onChange={setSelectedIndex}
        />

        {/* ── Body ──────────────────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {listLoading ? (
            <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
              <span className="animate-pulse">Loading versions…</span>
            </div>
          ) : versions.length === 0 ? (
            <EmptyState />
          ) : (
            <>
              {/* Version list */}
              <div
                className="overflow-y-auto flex-shrink-0 border-b border-border"
                style={{ maxHeight: '220px' }}
              >
                <div className="p-2 flex flex-col gap-0.5">
                  {versions.map((v, idx) => (
                    <VersionItem
                      key={v.id}
                      version={v}
                      selected={idx === selectedIndex}
                      onSelect={() => setSelectedIndex(idx)}
                    />
                  ))}
                </div>
              </div>

              {/* Preview pane */}
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2 border-b border-border flex-shrink-0">
                  <span className="text-[11px] font-medium text-text-muted uppercase tracking-wide">
                    Preview
                    {selectedVersion && (
                      <span className="ml-1.5 font-mono normal-case text-accent">
                        v{selectedVersion.versionNum}
                      </span>
                    )}
                  </span>
                  {detailLoading && (
                    <span className="text-[10px] text-text-muted animate-pulse">Loading…</span>
                  )}
                </div>

                <div className="flex-1 overflow-hidden">
                  {detailLoading ? (
                    <SkeletonPreview />
                  ) : versionDetail?.snapshotBase64 ? (
                    <VersionPreview
                      key={versionDetail.id}
                      snapshotBase64={versionDetail.snapshotBase64}
                    />
                  ) : (
                    <p className="p-4 text-xs text-text-muted">Select a version to preview.</p>
                  )}
                </div>

                {/* Restore footer */}
                {selectedVersion && canWrite && (
                  <div className="px-4 py-3 border-t border-border flex-shrink-0 bg-surface-1">
                    {confirmRestore ? (
                      <div className="flex flex-col gap-2">
                        <p className="text-xs text-text-secondary leading-relaxed">
                          Restore{' '}
                          <strong className="text-text-primary font-medium">
                            v{selectedVersion.versionNum}
                          </strong>
                          {selectedVersion.label && (
                            <span className="text-accent"> &ldquo;{selectedVersion.label}&rdquo;</span>
                          )}
                          ? This replaces the current state for all collaborators.
                        </p>
                        <div className="flex gap-2">
                          <button
                            onClick={() => void handleRestore()}
                            disabled={restoreMutation.isPending}
                            className="flex-1 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors"
                          >
                            {restoreMutation.isPending ? 'Restoring…' : 'Confirm'}
                          </button>
                          <button
                            onClick={() => setConfirmRestore(false)}
                            className="flex-1 py-1.5 rounded-lg bg-surface-3 text-text-secondary text-xs font-medium hover:bg-surface-4 transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmRestore(true)}
                        className="w-full py-2 rounded-lg border border-border text-text-secondary text-xs font-medium hover:bg-surface-3 hover:text-text-primary transition-colors"
                      >
                        Restore v{selectedVersion.versionNum}
                        {selectedVersion.label && (
                          <span className="text-text-muted"> — {selectedVersion.label}</span>
                        )}
                      </button>
                    )}
                    {restoreMutation.isError && (
                      <p className="mt-1.5 text-[11px] text-red-400">
                        Restore failed. Please try again.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ── Sub-components / helpers ──────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center py-8">
      <ClockIcon large />
      <p className="text-sm text-text-secondary">No versions yet</p>
      <p className="text-xs text-text-muted max-w-[220px] leading-relaxed">
        Versions are captured automatically every minute and whenever you save a named checkpoint.
      </p>
    </div>
  );
}

function SkeletonPreview() {
  return (
    <div className="p-4 space-y-2.5">
      {[80, 65, 75, 50, 90].map((w, i) => (
        <div
          key={i}
          className="h-3 skeleton rounded-sm"
          style={{ width: `${w}%` }}
        />
      ))}
    </div>
  );
}

function ClockIcon({ large }: { large?: boolean }) {
  const size = large ? 36 : 14;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={large ? 'text-text-muted opacity-30' : 'text-text-muted flex-shrink-0'}
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
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

// ── Utility formatters ────────────────────────────────────────────────────────

function formatRelative(date: Date): string {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
