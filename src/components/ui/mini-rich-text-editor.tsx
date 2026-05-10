import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Underline from "@tiptap/extension-underline";
import { useEffect, useState } from "react";
import { Toggle } from "@/components/ui/toggle";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  List,
  ListOrdered,
  Link as LinkIcon,
  Code as CodeIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface MiniRichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
  /** CSS min-height for the editor area (e.g. "60px", "320px"). */
  minHeight?: string;
  /** When true, show a Visual / HTML toggle that exposes a raw HTML textarea. */
  allowHtmlView?: boolean;
}

export function MiniRichTextEditor({
  value,
  onChange,
  placeholder,
  className,
  minHeight = "60px",
  allowHtmlView = false,
}: MiniRichTextEditorProps) {
  const [htmlMode, setHtmlMode] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        codeBlock: false,
        code: false,
        horizontalRule: false,
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          class: "text-primary underline",
        },
      }),
      Placeholder.configure({
        placeholder: placeholder || "",
      }),
    ],
    content: value,
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
    editorProps: {
      attributes: {
        class:
          "prose prose-sm dark:prose-invert max-w-none px-3 py-2 focus:outline-none [&_p]:my-0 [&_p+p]:mt-2 [&_ul]:my-1 [&_ol]:my-1",
        style: `min-height: ${minHeight};`,
      },
    },
  });

  useEffect(() => {
    if (editor && !htmlMode && value !== editor.getHTML()) {
      editor.commands.setContent(value || "");
    }
  }, [value, editor, htmlMode]);

  const addLink = () => {
    if (!editor) return;
    const url = window.prompt("Enter URL:");
    if (url) {
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    }
  };

  const toggleHtmlMode = () => {
    if (!editor) return;
    if (htmlMode) {
      // Switching back to visual: push the textarea contents into the editor
      editor.commands.setContent(value || "");
    }
    setHtmlMode((m) => !m);
  };

  return (
    <div
      className={cn(
        "rounded-md border border-input bg-background ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
        className
      )}
    >
      <div className="flex items-center gap-1 border-b border-input bg-muted/50 px-1 py-0.5 rounded-t-md">
        <Toggle
          size="sm"
          pressed={editor?.isActive("bold") ?? false}
          onPressedChange={() => editor?.chain().focus().toggleBold().run()}
          disabled={htmlMode}
          aria-label="Bold"
        >
          <Bold className="h-3.5 w-3.5" />
        </Toggle>
        <Toggle
          size="sm"
          pressed={editor?.isActive("italic") ?? false}
          onPressedChange={() => editor?.chain().focus().toggleItalic().run()}
          disabled={htmlMode}
          aria-label="Italic"
        >
          <Italic className="h-3.5 w-3.5" />
        </Toggle>
        <Toggle
          size="sm"
          pressed={editor?.isActive("underline") ?? false}
          onPressedChange={() => editor?.chain().focus().toggleUnderline().run()}
          disabled={htmlMode}
          aria-label="Underline"
        >
          <UnderlineIcon className="h-3.5 w-3.5" />
        </Toggle>
        <Separator orientation="vertical" className="mx-0.5 h-5" />
        <Toggle
          size="sm"
          pressed={editor?.isActive("bulletList") ?? false}
          onPressedChange={() => editor?.chain().focus().toggleBulletList().run()}
          disabled={htmlMode}
          aria-label="Bullet List"
        >
          <List className="h-3.5 w-3.5" />
        </Toggle>
        <Toggle
          size="sm"
          pressed={editor?.isActive("orderedList") ?? false}
          onPressedChange={() => editor?.chain().focus().toggleOrderedList().run()}
          disabled={htmlMode}
          aria-label="Ordered List"
        >
          <ListOrdered className="h-3.5 w-3.5" />
        </Toggle>
        <Separator orientation="vertical" className="mx-0.5 h-5" />
        <Toggle
          size="sm"
          pressed={editor?.isActive("link") ?? false}
          onPressedChange={addLink}
          disabled={htmlMode}
          aria-label="Add Link"
        >
          <LinkIcon className="h-3.5 w-3.5" />
        </Toggle>
        {allowHtmlView && (
          <>
            <Separator orientation="vertical" className="mx-0.5 h-5" />
            <Button
              type="button"
              variant={htmlMode ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2 text-xs gap-1"
              onClick={toggleHtmlMode}
              aria-pressed={htmlMode}
            >
              <CodeIcon className="h-3.5 w-3.5" />
              {htmlMode ? "Visual" : "HTML"}
            </Button>
          </>
        )}
      </div>
      {htmlMode ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full px-3 py-2 font-mono text-xs bg-background text-foreground focus:outline-none resize-y rounded-b-md"
          style={{ minHeight }}
        />
      ) : (
        <EditorContent editor={editor} />
      )}
    </div>
  );
}
