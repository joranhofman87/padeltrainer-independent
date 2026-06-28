import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SafeHtml } from '@/components/ui/SafeHtml';

// SafeHtml is the ONLY runtime consumer of dompurify (the one prod dependency still flagged by
// `npm audit` because dompurify's latest published version is 3.4.8, still <=3.4.10). These tests
// pin the actual sanitization contract — XSS stripped, the component's opted-in tags/attrs kept — so
// (a) the dompurify bump in this PR is proven not to have weakened sanitization, and (b) any future
// dompurify upgrade is guarded. The flagged advisories (Trusted-Types output mode, SAFE_FOR_TEMPLATES,
// persistent setConfig/hooks) are NOT reachable through this inline-config sanitize() usage.
const renderHtml = (html: string): string =>
  (render(<SafeHtml html={html} />).container.querySelector('div') as HTMLDivElement).innerHTML;

describe('SafeHtml — DOMPurify sanitization contract (guards the dompurify dependency)', () => {
  it('strips <script> and its contents', () => {
    const out = renderHtml('<b>hi</b><script>alert(1)</script>');
    expect(out).toContain('<b>hi</b>');
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toContain('alert(1)');
  });

  it('strips inline event handlers (onerror) — classic XSS vector', () => {
    const out = renderHtml('<img src="x" onerror="alert(2)">');
    expect(out).not.toMatch(/onerror/i);
    expect(out).not.toContain('alert(2)');
  });

  it('neutralizes javascript: hrefs', () => {
    const out = renderHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toMatch(/javascript:/i);
  });

  it('keeps benign formatting and the link attrs the component opts into (target, rel)', () => {
    const out = renderHtml('<p><strong>bold</strong></p><a href="https://example.com" target="_blank" rel="noopener">l</a>');
    expect(out).toContain('<strong>bold</strong>'); // benign formatting preserved
    expect(out).toContain('target="_blank"'); // ADD_ATTR: ['target', 'rel']
    expect(out).toContain('rel="noopener"');
  });
});
