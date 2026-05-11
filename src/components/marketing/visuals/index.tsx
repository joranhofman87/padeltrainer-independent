/**
 * Marketing visuals kit — pure Tailwind/SVG mini illustrations + window chrome.
 * Used to give all marketing pages the same look as the homepage SolutionOverview.
 * Strict rules: only design-token colors (brand-*, navy-*, muted, card, destructive),
 * no raster images, no new dependencies, no inline hex.
 */
import * as React from 'react';
import { cn } from '@/lib/utils';

/* ----------------------------- Window chrome ---------------------------- */

interface MockWindowProps {
  title?: string;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}

export function MockWindow({ title, className, bodyClassName, children }: MockWindowProps) {
  return (
    <div
      className={cn(
        'card-chip overflow-hidden bg-card border border-navy-900/10 shadow-soft',
        className,
      )}
      aria-hidden
    >
      <div className="flex items-center gap-1.5 px-4 py-3 border-b border-navy-900/5 bg-cream/40">
        <span className="h-2.5 w-2.5 rounded-full bg-destructive/40" />
        <span className="h-2.5 w-2.5 rounded-full bg-brand-500/40" />
        <span className="h-2.5 w-2.5 rounded-full bg-brand-500/70" />
        {title && (
          <span className="ml-3 text-[11px] font-medium text-navy-600 truncate">{title}</span>
        )}
      </div>
      <div className={cn('p-5', bodyClassName)}>{children}</div>
    </div>
  );
}

/* ----------------------------- Mini visuals ----------------------------- */

export function MiniCalendarGrid({ className }: { className?: string }) {
  const slots = [1, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 0, 1, 1, 1];
  return (
    <div className={cn('grid grid-cols-5 gap-1 w-fit', className)} aria-hidden>
      {slots.map((filled, i) => (
        <div
          key={i}
          className={`h-3 w-5 rounded-sm ${filled ? 'bg-brand-500/70' : 'bg-muted'}`}
        />
      ))}
    </div>
  );
}

export function MiniChecklist({ className }: { className?: string }) {
  return (
    <div className={cn('space-y-1.5 w-fit', className)} aria-hidden>
      {[true, true, true, false].map((done, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <div
            className={`h-3 w-3 rounded-sm border ${
              done ? 'bg-brand-500 border-brand-500' : 'border-muted-foreground/30'
            }`}
          />
          <div
            className={`h-1.5 rounded-full ${
              done ? 'w-12 bg-muted-foreground/20' : 'w-16 bg-muted-foreground/30'
            }`}
          />
        </div>
      ))}
    </div>
  );
}

export function MiniPhoneBooking({ className }: { className?: string }) {
  return (
    <div
      className={cn('w-14 rounded-lg border border-navy-900/10 bg-card p-1.5 space-y-1', className)}
      aria-hidden
    >
      <div className="h-1.5 w-8 rounded-full bg-brand-500/60" />
      <div className="h-1 w-10 rounded-full bg-muted" />
      <div className="h-4 rounded bg-brand-500/10 flex items-center justify-center">
        <div className="h-1.5 w-6 rounded-full bg-brand-500/40" />
      </div>
    </div>
  );
}

export function MiniShield({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-1.5 w-fit', className)} aria-hidden>
      <div className="h-8 w-6 rounded-sm bg-brand-500/15 relative overflow-hidden">
        <div className="absolute inset-x-0 bottom-0 h-5 bg-brand-500/30 rounded-sm" />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="h-2 w-2 rounded-full bg-brand-500/60" />
        </div>
      </div>
      <div className="h-8 w-6 rounded-sm bg-destructive/10 relative overflow-hidden flex items-center justify-center">
        <div className="w-4 h-px bg-destructive/40 rotate-45" />
      </div>
    </div>
  );
}

export function MiniBarChart({ className }: { className?: string }) {
  const bars = [40, 65, 50, 80, 95];
  return (
    <div className={cn('flex items-end gap-1 h-10 w-fit', className)} aria-hidden>
      {bars.map((h, i) => (
        <div
          key={i}
          className="w-2 rounded-sm bg-brand-500/70"
          style={{ height: `${h}%` }}
        />
      ))}
    </div>
  );
}

export function MiniRacketSwatch({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('w-7 h-7', className)} aria-hidden fill="none">
      <ellipse cx="13" cy="13" rx="9" ry="10" className="stroke-brand-500" strokeWidth="2" />
      <path d="M5 5 Q9 9 9 9" className="stroke-brand-500/40" strokeWidth="1" />
      <path d="M9 9 Q13 13 13 13" className="stroke-brand-500/40" strokeWidth="1" />
      <line x1="20" y1="20" x2="28" y2="28" className="stroke-navy-700" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function MiniCourtDiagram({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 28" className={cn('w-10 h-7', className)} aria-hidden fill="none">
      <rect x="1" y="1" width="38" height="26" rx="2" className="stroke-brand-500" strokeWidth="1.5" />
      <line x1="20" y1="1" x2="20" y2="27" className="stroke-brand-500/60" strokeWidth="1" />
      <line x1="1" y1="9" x2="39" y2="9" className="stroke-brand-500/40" strokeWidth="1" />
      <line x1="1" y1="19" x2="39" y2="19" className="stroke-brand-500/40" strokeWidth="1" />
      <circle cx="14" cy="14" r="1.4" className="fill-brand-500" />
    </svg>
  );
}

export function MiniVideoFrame({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'w-14 h-9 rounded-md bg-navy-900/90 flex items-center justify-center relative overflow-hidden',
        className,
      )}
      aria-hidden
    >
      <div className="absolute inset-0 bg-gradient-to-br from-brand-500/30 to-transparent" />
      <svg viewBox="0 0 12 12" className="relative w-3 h-3 text-cream">
        <polygon points="3,2 10,6 3,10" fill="currentColor" />
      </svg>
    </div>
  );
}

export function MiniArticleCard({ className }: { className?: string }) {
  return (
    <div
      className={cn('w-14 rounded-md border border-navy-900/10 bg-card p-1.5 space-y-1', className)}
      aria-hidden
    >
      <div className="h-3 w-full rounded-sm bg-brand-500/15" />
      <div className="h-1 w-10 rounded-full bg-navy-900/30" />
      <div className="h-1 w-8 rounded-full bg-muted" />
    </div>
  );
}

export function MiniQuizDots({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-1', className)} aria-hidden>
      <div className="h-2.5 w-2.5 rounded-full bg-brand-500" />
      <div className="h-2.5 w-2.5 rounded-full bg-brand-500" />
      <div className="h-2.5 w-2.5 rounded-full bg-brand-500/60" />
      <div className="h-2.5 w-2.5 rounded-full bg-muted" />
      <div className="h-2.5 w-2.5 rounded-full bg-muted" />
    </div>
  );
}

export function MiniMapPin({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn('w-5 h-5', className)} aria-hidden fill="none">
      <path
        d="M12 22s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12Z"
        className="stroke-brand-500 fill-brand-500/15"
        strokeWidth="1.5"
      />
      <circle cx="12" cy="10" r="2.4" className="fill-brand-500" />
    </svg>
  );
}

export function MiniStarRating({ className, filled = 4 }: { className?: string; filled?: number }) {
  return (
    <div className={cn('flex items-center gap-0.5', className)} aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <svg key={i} viewBox="0 0 12 12" className={`w-3 h-3 ${i < filled ? 'text-brand-500' : 'text-muted'}`}>
          <polygon
            points="6,1 7.5,4.5 11,5 8.3,7.5 9,11 6,9.2 3,11 3.7,7.5 1,5 4.5,4.5"
            fill="currentColor"
          />
        </svg>
      ))}
    </div>
  );
}
