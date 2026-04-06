import { useRef, useEffect } from 'react';
import DOMPurify from 'dompurify';

interface SafeHtmlProps {
  html: string;
  className?: string;
}

/**
 * Renders sanitized HTML without React tracking inner DOM nodes.
 * Prevents XSS attacks via DOMPurify and avoids reconciliation crashes from third-party scripts.
 */
export function SafeHtml({ html, className }: SafeHtmlProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.innerHTML = DOMPurify.sanitize(html, {
        ADD_TAGS: ['style'],
        ADD_ATTR: ['target', 'rel'],
      });
    }
  }, [html]);

  return <div ref={ref} className={className} />;
}
