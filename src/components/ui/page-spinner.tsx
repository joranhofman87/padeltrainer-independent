import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Canonical full-page initial-load spinner — replaces the copy-pasted
 * `min-h-screen flex items-center justify-center bg-background` + `Loader2 h-8 w-8 text-primary` blocks
 * scattered across public / auth / onboarding / detail pages.
 *
 * Scope: whole-page initial load ONLY. Do NOT use for per-section spinners, button-submit spinners, or
 * status cards with text (e.g. the Mollie-callback "Connecting…" card) — those are intentionally bespoke.
 */
export function FullPageLoader({
  className,
  spinnerClassName,
  label,
}: {
  className?: string;
  /** Override the spinner's size/colour when a page needs a non-default look. */
  spinnerClassName?: string;
  /** Optional screen-reader label. */
  label?: string;
}) {
  return (
    <div className={cn('flex min-h-screen items-center justify-center bg-background', className)}>
      <Loader2 className={cn('h-8 w-8 animate-spin text-primary', spinnerClassName)} aria-hidden="true" />
      {label ? <span className="sr-only">{label}</span> : null}
    </div>
  );
}
