export type RatingSystem = 'knltb' | 'playtomic';

export interface RatingSystemConfig {
  id: RatingSystem;
  name: string;
  min: number;
  max: number;
  step: number;
}

export const RATING_SYSTEMS: Record<RatingSystem, RatingSystemConfig> = {
  knltb: {
    id: 'knltb',
    name: 'KNLTB',
    min: 0.1,
    max: 9.9,
    step: 0.1,
  },
  playtomic: {
    id: 'playtomic',
    name: 'Playtomic',
    min: 0.1,
    max: 6.0,
    step: 0.1,
  },
};

export const DEFAULT_RATING_SYSTEM: RatingSystem = 'knltb';

export function getRatingSystemConfig(system: RatingSystem | string | null | undefined): RatingSystemConfig {
  if (system && system in RATING_SYSTEMS) {
    return RATING_SYSTEMS[system as RatingSystem];
  }
  return RATING_SYSTEMS[DEFAULT_RATING_SYSTEM];
}

export function validateRating(rating: number | null | undefined, system: RatingSystem | string | null | undefined): boolean {
  if (rating === null || rating === undefined) return true;
  const config = getRatingSystemConfig(system);
  return rating >= config.min && rating <= config.max;
}

export function formatRatingWithSystem(rating: number | null | undefined, system: RatingSystem | string | null | undefined): string {
  if (rating === null || rating === undefined) return '—';
  const config = getRatingSystemConfig(system);
  return `${rating.toFixed(1)} (${config.name})`;
}
