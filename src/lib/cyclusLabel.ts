// Build a rich, identifying label for a training cyclus to show in selection
// dropdowns (e.g. the copy-slots / bulk-copy wizard): "{Day} {time} (FirstNames) ·
// Location". Computed LIVE from the current roster — never stored on cycles.name,
// which is player-facing (invoices/emails/calendar/SEO) and would leak other
// players' names + drift as the roster changes.
//
// The roster is aggregated SERVER-SIDE via get_academy_cyclus_labels (one RPC):
// a busy academy has dozens of cyclus cycles and 1000s of slots/bookings, which
// blows past PostgREST's row cap + URL-length limits if done client-side.
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';

// Academy default timezone (NL-centric app); day/time are formatted here so they
// match what the academy sees on the calendar.
const TZ = 'Europe/Amsterdam';
const dayFmt = new Intl.DateTimeFormat('nl-NL', { weekday: 'short', timeZone: TZ });
const timeFmt = new Intl.DateTimeFormat('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: TZ });

export interface CyclusRosterEntry {
  dayTime: string | null; // "Ma 18:00" — null for cycles with no slots
  firstNames: string[];
  locationName: string | null;
}

interface CyclusLabelRow {
  cycle_id: string;
  earliest_start: string | null;
  first_names: string[] | null;
  location_name: string | null;
}

function formatDayTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const day = dayFmt.format(d).replace(/\.$/, ''); // nl short weekday e.g. "ma"
  return `${day.charAt(0).toUpperCase()}${day.slice(1)} ${timeFmt.format(d)}`;
}

/**
 * Academy cyclus labels (day/time + distinct roster first names + location) in a
 * single RPC call. Returns an empty map for non-academy owners (and pre-migration
 * the RPC 404s → caught → empty), so callers always fall back to cycle.name.
 */
export async function fetchCyclusLabels(
  ownerType: 'trainer' | 'club' | 'academy',
  ownerId: string,
): Promise<Map<string, CyclusRosterEntry>> {
  const result = new Map<string, CyclusRosterEntry>();
  if (ownerType !== 'academy' || !ownerId) return result;
  try {
    const { data, error } = await supabase.rpc('get_academy_cyclus_labels', {
      p_academy_profile_id: ownerId,
    });
    if (error) throw error;
    for (const row of (data ?? []) as CyclusLabelRow[]) {
      result.set(row.cycle_id, {
        dayTime: formatDayTime(row.earliest_start),
        firstNames: row.first_names ?? [],
        locationName: row.location_name ?? null,
      });
    }
  } catch (err) {
    logger.error('fetchCyclusLabels failed (non-blocking)', err instanceof Error ? err : new Error(String(err)), {
      component: 'cyclusLabel',
    });
  }
  return result;
}

/**
 * "{Day} {time} (Joran, Nick) · Location". Caps the names list; no players → drops
 * the parens; no location → drops the suffix. Returns null when there is no
 * day/time (non-cyclus / no slots) so the caller falls back to cycle.name.
 */
export function buildCyclusLabel(entry: CyclusRosterEntry | undefined, nameCap = 4): string | null {
  if (!entry || !entry.dayTime) return null;
  let label = entry.dayTime;
  if (entry.firstNames.length > 0) {
    const shown = entry.firstNames.slice(0, nameCap);
    const extra = entry.firstNames.length - shown.length;
    label += ` (${shown.join(', ')}${extra > 0 ? `, +${extra}` : ''})`;
  }
  if (entry.locationName) label += ` · ${entry.locationName}`;
  return label;
}
