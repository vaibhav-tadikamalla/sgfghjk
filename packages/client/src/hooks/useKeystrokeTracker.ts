import { useEffect, useRef, useState, useCallback } from 'react';
import type { Editor } from '@tiptap/react';

export interface KeystrokeStats {
  /** Peak characters inserted in any single 1-second window */
  maxCharsPerSecond: number;
  /** Current (live) characters per second in the latest 1-second window */
  currentCharsPerSecond: number;
  /** Whether a paste event was directly detected */
  pasteDetected: boolean;
  /** Total number of paste events detected in this session */
  pasteCount: number;
  /** Total characters inserted via paste */
  totalPastedChars: number;
  /** Whether the chars-per-second exceeds human typing threshold */
  suspiciousBurst: boolean;
  /** Reset the tracker (e.g. on file change) */
  reset: () => void;
}

/**
 * Tracks character insertion velocity in a TipTap editor.
 * Records the maximum number of characters inserted within any
 * 1-second sliding window. A burst above ~20 chars/sec is flagged
 * as suspicious (likely copy-paste), since elite typists rarely
 * exceed 12-15 chars/sec sustained.
 *
 * IMPORTANT: Only counts LOCAL transactions — remote Yjs sync
 * changes are filtered out so collaborators don't inflate stats.
 */
export function useKeystrokeTracker(editor: Editor | null): KeystrokeStats {
  const HUMAN_THRESHOLD = 20; // chars per second — above this = suspicious
  const WINDOW_MS = 1000;     // 1 second sliding window
  const LIVE_INTERVAL_MS = 500; // how often to update the live CPS display

  // Ring buffer of { timestamp, charCount } entries
  const eventsRef = useRef<{ ts: number; chars: number }[]>([]);
  const [maxCps, setMaxCps] = useState(0);
  const [currentCps, setCurrentCps] = useState(0);
  const [pasteDetected, setPasteDetected] = useState(false);
  const [pasteCount, setPasteCount] = useState(0);
  const [totalPastedChars, setTotalPastedChars] = useState(0);
  const maxCpsRef = useRef(0);

  // Flag to mark the next transaction as paste-originated
  const nextTxIsPasteRef = useRef(false);
  const lastPasteSignalAtRef = useRef(0);

  const registerPasteSignal = useCallback(() => {
    const now = Date.now();
    setPasteDetected(true);
    // De-dupe multiple paste signals that can fire for one user action.
    if (now - lastPasteSignalAtRef.current > 150) {
      setPasteCount((c) => c + 1);
    }
    nextTxIsPasteRef.current = true;
    lastPasteSignalAtRef.current = now;
  }, []);

  const reset = useCallback(() => {
    eventsRef.current = [];
    maxCpsRef.current = 0;
    setMaxCps(0);
    setCurrentCps(0);
    setPasteDetected(false);
    setPasteCount(0);
    setTotalPastedChars(0);
  }, []);

  useEffect(() => {
    if (!editor) return;

    const dom = editor.view.dom;

    // --- Direct paste detection ---
    const handlePaste = (_event: Event) => {
      registerPasteSignal();
    };

    // Captures editor insertions that are paste-like but may not dispatch a
    // regular paste event across all browser/editor combinations.
    const handleBeforeInput = (event: Event) => {
      const inputEvent = event as InputEvent;
      const inputType = inputEvent.inputType ?? '';
      if (inputType === 'insertFromPaste' || inputType === 'insertFromDrop') {
        registerPasteSignal();
      }
    };

    const handleDrop = (_event: Event) => {
      registerPasteSignal();
    };

    // --- Character velocity tracking via ProseMirror transactions ---
    const handleTransaction = ({ transaction }: { transaction: any }) => {
      if (!transaction.docChanged) return;

      // CRITICAL: Skip remote transactions from Yjs collaboration sync.
      // Remote changes have meta 'y-sync$' set by the Collaboration extension.
      // Without this filter, other users' typing would inflate our stats.
      const isRemote =
        transaction.getMeta('y-sync$') ||
        transaction.getMeta('addToHistory') === false;
      if (isRemote) return;

      // Fallback for paste/drop operations that only surface in transaction
      // metadata and not via DOM events.
      const uiEventType = transaction.getMeta('uiEvent');
      if ((uiEventType === 'paste' || uiEventType === 'drop') && Date.now() - lastPasteSignalAtRef.current > 150) {
        registerPasteSignal();
      }

      // Count inserted characters in this transaction
      let insertedChars = 0;
      transaction.steps.forEach((step: any) => {
        // ReplaceStep carries a `slice` with content
        if (step.slice) {
          step.slice.content.forEach((node: any) => {
            if (node.isText) {
              insertedChars += node.text?.length ?? 0;
            } else {
              // For non-text nodes (paragraphs, etc.), count their text content
              insertedChars += node.textContent?.length ?? 0;
            }
          });
        }
      });

      if (insertedChars === 0) return;

      // Track pasted characters
      if (nextTxIsPasteRef.current) {
        setTotalPastedChars((prev) => prev + insertedChars);
        nextTxIsPasteRef.current = false;
      }

      const now = Date.now();
      eventsRef.current.push({ ts: now, chars: insertedChars });

      // Prune events older than the window
      const cutoff = now - WINDOW_MS;
      eventsRef.current = eventsRef.current.filter((e) => e.ts >= cutoff);

      // Sum chars in the current 1-second window
      const windowTotal = eventsRef.current.reduce((sum, e) => sum + e.chars, 0);

      if (windowTotal > maxCpsRef.current) {
        maxCpsRef.current = windowTotal;
        setMaxCps(windowTotal);
      }
    };

    dom.addEventListener('paste', handlePaste);
    dom.addEventListener('beforeinput', handleBeforeInput as EventListener);
    dom.addEventListener('drop', handleDrop);
    editor.on('transaction', handleTransaction);

    // Periodic live CPS update (decays naturally when user stops typing)
    const intervalId = setInterval(() => {
      const now = Date.now();
      const cutoff = now - WINDOW_MS;
      eventsRef.current = eventsRef.current.filter((e) => e.ts >= cutoff);
      const liveTotal = eventsRef.current.reduce((sum, e) => sum + e.chars, 0);
      setCurrentCps(liveTotal);
    }, LIVE_INTERVAL_MS);

    return () => {
      dom.removeEventListener('paste', handlePaste);
      dom.removeEventListener('beforeinput', handleBeforeInput as EventListener);
      dom.removeEventListener('drop', handleDrop);
      editor.off('transaction', handleTransaction);
      clearInterval(intervalId);
    };
  }, [editor, registerPasteSignal]);

  return {
    maxCharsPerSecond: maxCps,
    currentCharsPerSecond: currentCps,
    pasteDetected,
    pasteCount,
    totalPastedChars,
    suspiciousBurst: maxCps > HUMAN_THRESHOLD,
    reset,
  };
}
