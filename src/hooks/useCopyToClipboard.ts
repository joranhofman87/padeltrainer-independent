import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Copy text to the clipboard, resiliently. Prefers the async Clipboard API (in a secure context) and
 * falls back to a hidden-textarea `execCommand('copy')` for non-secure contexts / older browsers — the
 * fallback matters because plain `navigator.clipboard.writeText` silently throws off-HTTPS.
 *
 * This is the single source of truth for "copy a string" across the app; surfaces should use this
 * hook (or {@link CopyLinkButton}) instead of hand-rolling `navigator.clipboard.writeText`.
 *
 * @returns `copied` (flips true briefly after a successful copy, for a Check-icon state) and
 *          `copy(text)` (resolves to whether the write succeeded — callers own their own toast).
 */
export function useCopyToClipboard(resetMs = 1500): {
  copied: boolean;
  copy: (text: string) => Promise<boolean>;
} {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = useCallback(async (text: string): Promise<boolean> => {
    const ok = await writeToClipboard(text);
    if (ok) {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), resetMs);
    }
    return ok;
  }, [resetMs]);

  return { copied, copy };
}

/** Raw clipboard write with the secure-context guard + execCommand fallback (no React state). */
export async function writeToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the execCommand fallback
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
