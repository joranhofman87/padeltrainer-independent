

# Add WYSIWYG Editor for Onboarding Emails

## Overview
Replace the raw HTML textarea with a user-friendly rich text editor so admins can compose emails visually without needing to know HTML. The editor will provide a toolbar with formatting options like bold, italic, headings, links, and lists.

## Solution

We'll integrate **TipTap** - a modern, lightweight WYSIWYG editor built on top of ProseMirror that works perfectly with React and has excellent shadcn/ui compatibility.

### User Experience

**Before (Current)**:
- Plain textarea requiring HTML code
- Users must write `<h1>Welkom</h1>` manually
- Confusing for non-technical users

**After (New)**:
- Visual editor with familiar toolbar (like Word/Google Docs)
- Click "Bold" button to make text bold
- Click to insert links, headings, bullet lists
- Template variables can be inserted via button clicks
- Live preview of how the email will look

### Editor Toolbar Features
- **Text Formatting**: Bold, Italic, Underline
- **Headings**: H1, H2, H3
- **Lists**: Bullet list, Numbered list
- **Links**: Add/edit hyperlinks
- **Alignment**: Left, Center, Right
- **Variable Insertion**: Click to insert `{{user_name}}`, etc.

## Technical Implementation

### Dependencies to Add
```json
{
  "@tiptap/react": "^2.x",
  "@tiptap/starter-kit": "^2.x",
  "@tiptap/extension-link": "^2.x",
  "@tiptap/extension-underline": "^2.x",
  "@tiptap/extension-text-align": "^2.x",
  "@tiptap/extension-placeholder": "^2.x"
}
```

### Files to Create/Modify

**1. New Component: `src/components/ui/rich-text-editor.tsx`**
A reusable WYSIWYG editor component built with TipTap that:
- Accepts HTML content and outputs HTML
- Provides a formatting toolbar
- Integrates with shadcn/ui styling
- Supports dark mode

**2. Modify: `src/components/admin/OnboardingEmailDialog.tsx`**
- Replace the `<Textarea>` with the new `<RichTextEditor>`
- Add variable insertion buttons that insert text at cursor position
- Update label from "Body (HTML)" to "Email Content"

**3. Update: `src/i18n/locales/en/admin.json` and `nl/admin.json`**
- Add new translation keys for editor toolbar buttons
- Update body field label

### Component Architecture

```text
OnboardingEmailDialog
    |
    +-- Form Fields (name, type, etc.)
    |
    +-- RichTextEditor
    |       |
    |       +-- Toolbar (Bold, Italic, Headings, etc.)
    |       |
    |       +-- Editor Content Area (WYSIWYG)
    |
    +-- Variable Insertion Buttons
```

### Key Implementation Details

**RichTextEditor Component**:
```typescript
// Simplified structure
interface RichTextEditorProps {
  value: string;           // HTML content
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
}

// Uses TipTap's useEditor hook
const editor = useEditor({
  extensions: [StarterKit, Link, Underline, TextAlign, Placeholder],
  content: value,
  onUpdate: ({ editor }) => onChange(editor.getHTML()),
});
```

**Variable Insertion**:
The template variable badges will include an "Insert" action that uses the editor's `insertContent` method to add variables at the cursor position:

```typescript
const insertVariable = (variable: string) => {
  editor?.commands.insertContent(variable);
};
```

### Styling
- Editor container styled to match existing form inputs
- Toolbar uses shadcn/ui Toggle components
- Proper focus states and borders
- Dark mode compatible using CSS variables

## Files Summary

| Action | File |
|--------|------|
| Create | `src/components/ui/rich-text-editor.tsx` |
| Modify | `src/components/admin/OnboardingEmailDialog.tsx` |
| Modify | `src/i18n/locales/en/admin.json` |
| Modify | `src/i18n/locales/nl/admin.json` |

