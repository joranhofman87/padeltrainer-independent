import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { useEffect } from "react";
import { Toggle } from "@/components/ui/toggle";
import { Separator } from "@/components/ui/separator";
import { Bold, List, ListOrdered, Link as LinkIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface MiniRichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
}

export function MiniRichTextEditor({
  value,
  onChange,
  placeholder,
  className,
}: MiniRichTextEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        codeBlock: false,
        code: false,
        horizontalRule: false,
      }),
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
        class: "prose prose-sm dark:prose-invert max-w-none min-h-[60px] px-3 py-2 focus:outline-none",
      },
    },
  });

  useEffect(() => {
    if (editor && value !== editor.getHTML()) {
      editor.commands.setContent(value);
    }
  }, [value, editor]);

  const addLink = () => {
    if (!editor) return;
    const url = window.prompt("Enter URL:");
    if (url) {
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    }
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
          aria-label="Bold"
        >
          <Bold className="h-3.5 w-3.5" />
        </Toggle>
        <Separator orientation="vertical" className="mx-0.5 h-5" />
        <Toggle
          size="sm"
          pressed={editor?.isActive("bulletList") ?? false}
          onPressedChange={() => editor?.chain().focus().toggleBulletList().run()}
          aria-label="Bullet List"
        >
          <List className="h-3.5 w-3.5" />
        </Toggle>
        <Toggle
          size="sm"
          pressed={editor?.isActive("orderedList") ?? false}
          onPressedChange={() => editor?.chain().focus().toggleOrderedList().run()}
          aria-label="Ordered List"
        >
          <ListOrdered className="h-3.5 w-3.5" />
        </Toggle>
        <Separator orientation="vertical" className="mx-0.5 h-5" />
        <Toggle
          size="sm"
          pressed={editor?.isActive("link") ?? false}
          onPressedChange={addLink}
          aria-label="Add Link"
        >
          <LinkIcon className="h-3.5 w-3.5" />
        </Toggle>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
