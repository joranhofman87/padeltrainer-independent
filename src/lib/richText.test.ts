import { describe, it, expect } from 'vitest';
import { isBlankRichTextHtml, normalizeRichTextHtml } from './richText';

describe('isBlankRichTextHtml', () => {
  it.each([null, undefined, '', '   ', '<p></p>', '<p>  </p>', '<p>&nbsp;</p>', '<p><br></p>'])(
    'treats %o as blank',
    (value) => {
      expect(isBlankRichTextHtml(value as string | null | undefined)).toBe(true);
    },
  );

  it.each(['<p>Pay within 7 days.</p>', '<ul><li>No refunds</li></ul>', 'plain text'])(
    'treats %o as non-blank',
    (value) => {
      expect(isBlankRichTextHtml(value)).toBe(false);
    },
  );
});

describe('normalizeRichTextHtml', () => {
  it('returns null for blank content', () => {
    expect(normalizeRichTextHtml('<p></p>')).toBeNull();
    expect(normalizeRichTextHtml(null)).toBeNull();
  });

  it('returns trimmed HTML for real content', () => {
    expect(normalizeRichTextHtml('  <p>Rules</p>  ')).toBe('<p>Rules</p>');
  });
});
