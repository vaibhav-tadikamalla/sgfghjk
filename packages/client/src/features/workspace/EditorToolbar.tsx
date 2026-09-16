import React from 'react';
import type { Editor } from '@tiptap/react';
import { cn } from '@/lib/utils/cn';

interface EditorToolbarProps {
  editor: Editor;
  onHistory?: () => void;
  onComments?: () => void;
}

function ToolBtn({
  active,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
      className={cn('tool-btn w-7 h-7', active && 'tool-btn-active')}
      title={title}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div className="w-px h-5 bg-border mx-0.5" />;
}

export function EditorToolbar({ editor, onHistory, onComments }: EditorToolbarProps) {
  return (
    <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-border bg-surface-1 flex-wrap">
      {/* Text formatting */}
      <ToolBtn
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
        title="Bold (Ctrl+B)"
      >
        <span className="text-xs font-bold">B</span>
      </ToolBtn>
      <ToolBtn
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        title="Italic (Ctrl+I)"
      >
        <span className="text-xs italic">I</span>
      </ToolBtn>
      <ToolBtn
        active={editor.isActive('underline')}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        title="Underline (Ctrl+U)"
      >
        <span className="text-xs underline">U</span>
      </ToolBtn>
      <ToolBtn
        active={editor.isActive('strike')}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        title="Strikethrough"
      >
        <span className="text-xs line-through">S</span>
      </ToolBtn>
      <ToolBtn
        active={editor.isActive('highlight')}
        onClick={() => editor.chain().focus().toggleHighlight().run()}
        title="Highlight"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="m9 11-6 6v3h9l3-3" />
          <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0L8.4 10.4a2 2 0 0 1 0-2.8L13 3" />
        </svg>
      </ToolBtn>

      <Divider />

      {/* Headings */}
      <ToolBtn
        active={editor.isActive('heading', { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        title="Heading 1"
      >
        <span className="text-[10px] font-bold">H1</span>
      </ToolBtn>
      <ToolBtn
        active={editor.isActive('heading', { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        title="Heading 2"
      >
        <span className="text-[10px] font-bold">H2</span>
      </ToolBtn>
      <ToolBtn
        active={editor.isActive('heading', { level: 3 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        title="Heading 3"
      >
        <span className="text-[10px] font-bold">H3</span>
      </ToolBtn>

      <Divider />

      {/* Lists */}
      <ToolBtn
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        title="Bullet List"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <circle cx="4" cy="6" r="1" fill="currentColor" />
          <circle cx="4" cy="12" r="1" fill="currentColor" />
          <circle cx="4" cy="18" r="1" fill="currentColor" />
        </svg>
      </ToolBtn>
      <ToolBtn
        active={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        title="Ordered List"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="10" y1="6" x2="21" y2="6" />
          <line x1="10" y1="12" x2="21" y2="12" />
          <line x1="10" y1="18" x2="21" y2="18" />
          <text x="2" y="8" fontSize="7" fill="currentColor" stroke="none">1</text>
          <text x="2" y="14" fontSize="7" fill="currentColor" stroke="none">2</text>
          <text x="2" y="20" fontSize="7" fill="currentColor" stroke="none">3</text>
        </svg>
      </ToolBtn>
      <ToolBtn
        active={editor.isActive('taskList')}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
        title="Task List"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="5" width="6" height="6" rx="1" />
          <path d="m5 8 1.5 1.5L9 7" />
          <line x1="13" y1="8" x2="21" y2="8" />
          <rect x="3" y="14" width="6" height="6" rx="1" />
          <line x1="13" y1="17" x2="21" y2="17" />
        </svg>
      </ToolBtn>

      <Divider />

      {/* Block elements */}
      <ToolBtn
        active={editor.isActive('blockquote')}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        title="Blockquote"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V21z" />
          <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V21z" />
        </svg>
      </ToolBtn>
      <ToolBtn
        active={editor.isActive('codeBlock')}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        title="Code Block"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      </ToolBtn>
      <ToolBtn
        active={editor.isActive('code')}
        onClick={() => editor.chain().focus().toggleCode().run()}
        title="Inline Code"
      >
        <span className="text-[10px] font-mono">{'{}'}</span>
      </ToolBtn>

      <Divider />

      {/* Text alignment */}
      <ToolBtn
        active={editor.isActive({ textAlign: 'left' })}
        onClick={() => editor.chain().focus().setTextAlign('left').run()}
        title="Align Left"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="15" y2="12" />
          <line x1="3" y1="18" x2="18" y2="18" />
        </svg>
      </ToolBtn>
      <ToolBtn
        active={editor.isActive({ textAlign: 'center' })}
        onClick={() => editor.chain().focus().setTextAlign('center').run()}
        title="Align Center"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="6" y1="12" x2="18" y2="12" />
          <line x1="4" y1="18" x2="20" y2="18" />
        </svg>
      </ToolBtn>
      <ToolBtn
        active={editor.isActive({ textAlign: 'right' })}
        onClick={() => editor.chain().focus().setTextAlign('right').run()}
        title="Align Right"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="9" y1="12" x2="21" y2="12" />
          <line x1="6" y1="18" x2="21" y2="18" />
        </svg>
      </ToolBtn>

      <Divider />

      {/* Horizontal rule */}
      <ToolBtn
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
        title="Horizontal Rule"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="3" y1="12" x2="21" y2="12" />
        </svg>
      </ToolBtn>

      {/* History */}
      {onHistory && (
        <>
          <Divider />
          <ToolBtn onClick={onHistory} title="Document History">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </ToolBtn>
        </>
      )}

      {/* Comments */}
      {onComments && (
        <>
          <Divider />
          <ToolBtn onClick={onComments} title="Comments">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </ToolBtn>
        </>
      )}
    </div>
  );
}
