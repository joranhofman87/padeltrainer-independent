/**
 * Agenda design tokens.
 *
 * Shared visual helpers for the academy Agenda page so every view (week,
 * day, month) shows trainers and fill states in the exact same way.
 *
 * Colors map back to design tokens defined in tailwind.config.ts /
 * index.css. We never reach for raw `bg-amber-…` / `bg-emerald-…` here.
 */

/** Six soft hues used to identify trainers consistently across the agenda. */
export const TRAINER_HUES = [
  { ring: 'bg-brand-500', soft: 'bg-brand-50', text: 'text-brand-700', border: 'border-brand-200' },
  { ring: 'bg-navy-500', soft: 'bg-navy-50', text: 'text-navy-700', border: 'border-navy-200' },
  { ring: 'bg-brand-400', soft: 'bg-brand-50/70', text: 'text-brand-600', border: 'border-brand-200' },
  { ring: 'bg-navy-400', soft: 'bg-navy-50/70', text: 'text-navy-600', border: 'border-navy-200' },
  { ring: 'bg-brand-600', soft: 'bg-brand-100/60', text: 'text-brand-700', border: 'border-brand-300' },
  { ring: 'bg-navy-600', soft: 'bg-navy-100/60', text: 'text-navy-700', border: 'border-navy-300' },
] as const;

export type TrainerHue = (typeof TRAINER_HUES)[number];

/**
 * Returns one of the six hues for a trainer in a deterministic way.
 * The same trainer always gets the same hue across renders.
 */
export function getTrainerHue(trainerId: string | null | undefined, fallbackIndex = 0): TrainerHue {
  if (!trainerId) return TRAINER_HUES[fallbackIndex % TRAINER_HUES.length];
  let hash = 0;
  for (let i = 0; i < trainerId.length; i++) {
    hash = (hash * 31 + trainerId.charCodeAt(i)) | 0;
  }
  return TRAINER_HUES[Math.abs(hash) % TRAINER_HUES.length];
}

export type FillState = 'empty' | 'open' | 'partial' | 'full' | 'past';

export function getFillState(args: {
  bookedCount: number;
  maxParticipants: number;
  isPast?: boolean;
}): FillState {
  if (args.isPast) return 'past';
  if (args.maxParticipants <= 0) return 'empty';
  if (args.bookedCount <= 0) return 'open';
  if (args.bookedCount >= args.maxParticipants) return 'full';
  return 'partial';
}

/** Returns semantic-token classes for a given fill state. */
export const fillStateClasses: Record<FillState, { bg: string; text: string; dot: string; border: string }> = {
  empty:   { bg: 'bg-muted/40',     text: 'text-muted-foreground', dot: 'bg-muted-foreground/30', border: 'border-border' },
  open:    { bg: 'bg-background',   text: 'text-foreground',       dot: 'bg-muted-foreground/40', border: 'border-border' },
  partial: { bg: 'bg-primary/5',    text: 'text-foreground',       dot: 'bg-primary/70',          border: 'border-primary/20' },
  full:    { bg: 'bg-primary/10',   text: 'text-foreground',       dot: 'bg-primary',             border: 'border-primary/30' },
  past:    { bg: 'bg-muted/30',     text: 'text-muted-foreground', dot: 'bg-muted-foreground/20', border: 'border-border' },
};
