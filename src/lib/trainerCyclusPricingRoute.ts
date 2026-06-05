import { lookupCyclesRowById } from '@/lib/cyclusPricingRoute';

export const TRAINER_CALENDAR_CYCLES_PATH = '/app/trainer/calendar';

export function buildTrainerCycleEditPath(cycleId: string): string {
  return `/app/trainer/cycles/${encodeURIComponent(cycleId)}/edit`;
}

export function buildTrainerCalendarCyclesFallbackPath(cyclusId: string): string {
  const params = new URLSearchParams({ tab: 'list', cyclusId });
  return `${TRAINER_CALENDAR_CYCLES_PATH}?${params.toString()}`;
}

/** Trainer cycle/session link: real cycle edit or calendar cycles tab. */
export async function resolveTrainerCyclusPricingRoute(cyclusId: string): Promise<string> {
  const lookup = await lookupCyclesRowById(cyclusId);
  if (lookup === 'exists') {
    return buildTrainerCycleEditPath(cyclusId);
  }
  return buildTrainerCalendarCyclesFallbackPath(cyclusId);
}
