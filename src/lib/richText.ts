/**
 * Helpers for rich-text HTML produced by the Tiptap editors (RichTextEditor / inline editors).
 *
 * An "empty" editor still emits markup like `<p></p>`, so a naive `!html` check treats a
 * visually-blank value as content. These helpers detect that and normalize it, so storage and the
 * `!!content && !accepted` consent gate agree (see RichTextConsent): blank rich text becomes null
 * at write time, which then renders nothing and never demands consent to an empty body.
 */

/** True when the HTML carries no visible text (null, whitespace, or an empty editor's `<p></p>`). */
export function isBlankRichTextHtml(html: string | null | undefined): boolean {
  if (!html) return true;
  return (
    html
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .trim().length === 0
  );
}

/** Returns trimmed HTML, or null when the content is visually blank (for storing a clean default). */
export function normalizeRichTextHtml(html: string | null | undefined): string | null {
  if (isBlankRichTextHtml(html)) return null;
  return (html as string).trim();
}
