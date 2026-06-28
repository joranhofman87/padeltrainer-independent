// Extracted verbatim from lib/cycles.ts (lib domain-split, behavior-frozen).
// Pure browser-side CSV export for intake requests; cycles.ts re-exports it so importers are unchanged.
import { format } from 'date-fns';
import type { IntakeRequestWithProposal, PlayerLink } from './cycles';

export function exportIntakeRequestsToCsv(
  requests: IntakeRequestWithProposal[],
  filename: string,
  trainerMap?: Record<string, string>, // id → name
  playerLinks?: PlayerLink[],
  locationMap?: Record<string, string>, // id → name
) {
  const dayKeys = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
  const dayHeaders = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  // Build link group lookup: requestId → set of linked request ids
  const linkedNamesMap = new Map<string, string[]>();
  if (playerLinks?.length) {
    const groupMap = new Map<string, string[]>();
    for (const pl of playerLinks) {
      if (!groupMap.has(pl.link_group)) groupMap.set(pl.link_group, []);
      groupMap.get(pl.link_group)!.push(pl.intake_request_id);
    }
    const nameMap = new Map(requests.map(r => [r.id, r.full_name]));
    for (const members of groupMap.values()) {
      for (const id of members) {
        const partners = members.filter(m => m !== id).map(m => nameMap.get(m) ?? m);
        if (partners.length) linkedNamesMap.set(id, partners);
      }
    }
  }

  const headers = [
    'Full Name', 'Email', 'Phone', 'Birth Date', 'Rating', 'Rating System',
    'Lesson Type', 'Location', 'Package', 'Preferred Weeks',
    ...dayHeaders,
    'Duration (min)', 'Sessions/Week', 'Preferred Trainers',
    'Notes', 'Status', 'Linked Players', 'Applied Date',
  ];

  const escCsv = (val: unknown) => `"${String(val ?? '').replace(/"/g, '""')}"`;

  const rows = requests.map((r) => {
    const trainers = (r.preferred_trainer_ids ?? [])
      .map((id) => trainerMap?.[id] ?? id)
      .join('; ');

    // Build a map: day → time ranges
    const windowsByDay: Record<string, string[]> = {};
    for (const tw of (r.preferred_time_windows ?? [])) {
      const key = (tw.day ?? '').toLowerCase();
      if (!windowsByDay[key]) windowsByDay[key] = [];
      windowsByDay[key].push(`${tw.start}-${tw.end}`);
    }

    const dayCols = dayKeys.map((day) => {
      if (windowsByDay[day]?.length) return windowsByDay[day].join('; ');
      // Day selected but no specific times → whole day
      if ((r.preferred_days ?? []).some((d: string) => d.toLowerCase() === day)) return '✓';
      return '';
    });

    const meta = r.metadata as Record<string, any> | undefined;
    const selectedOption = meta?.selected_cyclus_option;
    const packageLabel = selectedOption
      ? `${selectedOption.label ?? ''}${selectedOption.price != null ? ` (€${selectedOption.price})` : ''}`
      : '';
    const prefWeeks = meta?.preferred_number_of_weeks != null ? String(meta.preferred_number_of_weeks) : '';
    const locationName = r.location_id ? (locationMap?.[r.location_id] ?? '') : '';

    return [
      r.full_name,
      r.email,
      r.phone ?? '',
      r.birth_date ? format(new Date(r.birth_date), 'yyyy-MM-dd') : '',
      r.rating != null ? String(r.rating) : '',
      r.rating_system ?? '',
      Array.isArray(r.lesson_type) ? r.lesson_type.join('; ') : (r.lesson_type ?? ''),
      locationName,
      packageLabel,
      prefWeeks,
      ...dayCols,
      r.preferred_duration_minutes ? String(r.preferred_duration_minutes) : '',
      r.sessions_per_week ? String(r.sessions_per_week) : '',
      trainers,
      r.notes ?? '',
      r.status ?? '',
      (linkedNamesMap.get(r.id) ?? []).join('; '),
      r.created_at ? format(new Date(r.created_at), 'yyyy-MM-dd HH:mm') : '',
    ].map(escCsv).join(';');
  });

  const BOM = '\uFEFF';
  const csv = BOM + [headers.map(escCsv).join(';'), ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
