import { Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

// ── Type augmentation ─────────────────────────────────────────────────────────
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    comment: {
      /** Wrap the current selection in a comment mark with the given threadId. */
      setComment: (threadId: string) => ReturnType;
      /** Remove all comment marks from the current selection. */
      unsetComment: () => ReturnType;
    };
  }
}

// Custom DOM event emitted when the user clicks a comment mark.
// Listened to in CommentSidebar to activate the correct thread.
export const COMMENT_ACTIVATE_EVENT = 'peergrid:comment-activate';

export const CommentMark = Mark.create({
  name: 'comment',

  // Allow multiple comment marks to overlap (e.g. two threads on same text)
  excludes: '',
  // Don't extend the mark when typing at its boundary
  inclusive: false,

  addAttributes() {
    return {
      threadId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-thread-id'),
        renderHTML: (attrs: { threadId: string | null }) =>
          attrs.threadId ? { 'data-thread-id': attrs.threadId } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'mark[data-thread-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'mark',
      mergeAttributes({ class: 'comment-mark' }, HTMLAttributes),
      0,
    ];
  },

  addCommands() {
    return {
      setComment:
        (threadId: string) =>
        ({ commands }) =>
          commands.setMark(this.name, { threadId }),

      unsetComment:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('comment-click'),
        props: {
          handleClick(view, pos) {
            const marks = view.state.doc.resolve(pos).marks();
            const commentMark = marks.find((m) => m.type.name === 'comment');
            if (!commentMark) return false;

            const threadId = commentMark.attrs.threadId as string;
            if (!threadId) return false;

            document.dispatchEvent(
              new CustomEvent(COMMENT_ACTIVATE_EVENT, { detail: { threadId } }),
            );
            return false; // don't swallow the event so the cursor still moves
          },
        },
      }),
    ];
  },
});
