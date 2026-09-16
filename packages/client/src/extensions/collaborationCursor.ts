/**
 * Custom CollaborationCursor extension that uses @tiptap/y-tiptap
 * instead of the old y-prosemirror package.
 *
 * This is necessary because @tiptap/extension-collaboration@3.20.0 switched
 * from y-prosemirror to @tiptap/y-tiptap, and the old
 * @tiptap/extension-collaboration-cursor@3.0.0 still uses y-prosemirror.
 * The two packages create separate PluginKey instances that don't match,
 * causing "Cannot read properties of undefined (reading 'doc')".
 */
import { Extension } from '@tiptap/core';
import { yCursorPlugin, defaultSelectionBuilder } from '@tiptap/y-tiptap';
import type { Awareness } from 'y-protocols/awareness';

export interface CollaborationCursorOptions {
  awareness: Awareness;
  user: { name: string | null; color: string | null };
  render?: (user: { name: string; color: string }) => HTMLElement;
  selectionRender?: typeof defaultSelectionBuilder;
}

const defaultCursorRender = (user: { name: string; color: string }) => {
  const cursor = document.createElement('span');
  cursor.classList.add('collaboration-cursor__caret');
  cursor.setAttribute('style', `border-color: ${user.color}`);

  const label = document.createElement('div');
  label.classList.add('collaboration-cursor__label');
  label.setAttribute('style', `background-color: ${user.color}`);
  label.insertBefore(document.createTextNode(user.name), null);

  cursor.insertBefore(label, null);
  return cursor;
};

export const CollaborationCursorCustom = Extension.create<CollaborationCursorOptions>({
  name: 'collaborationCursor',

  addOptions() {
    return {
      awareness: null as unknown as Awareness,
      user: { name: null, color: null },
      render: defaultCursorRender,
      selectionRender: defaultSelectionBuilder,
    };
  },

  addProseMirrorPlugins() {
    const awareness = this.options.awareness;
    if (!awareness) return [];

    // Set local user info
    awareness.setLocalStateField('user', this.options.user);

    return [
      yCursorPlugin(
        awareness,
        {
          cursorBuilder: this.options.render ?? defaultCursorRender,
          selectionBuilder: this.options.selectionRender ?? defaultSelectionBuilder,
        },
      ),
    ];
  },
});
