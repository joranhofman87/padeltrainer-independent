// Per-series target-cycle naming for bulk-rebook-cycle. One rebook run now creates ONE target
// cycle per source series (owner's model: cycles stay separated; only rebook PROGRESS is combined),
// so each target needs a distinct, legible name that also satisfies the uniq_rebook_cycle_key
// unique index (owner_type, owner_id, name, start_date).
//
// Disambiguation chain (owner-approved): a single-series run keeps the round name VERBATIM
// (byte-identical to the old single-cycle behavior); multi-series runs append the series'
// "<Day> <HH:mm>" label, then — only where two series share day+time — the trainer name, then the
// location name, then a numeric suffix as the last resort.

export interface SeriesNameInput {
  /** Stable series identifier (the engine's seriesKey) — the map key of the result. */
  key: string;
  /** ISO start of the series' template slot — provides the weekday + time label. */
  startIso: string;
  trainerName?: string | null;
  locationName?: string | null;
}

/** "Wo 09:00"-style label in the academy's timezone (Dutch weekday abbreviation, capitalized). */
export function seriesLabel(startIso: string, tz: string): string {
  const d = new Date(startIso);
  const day = new Intl.DateTimeFormat("nl-NL", { weekday: "short", timeZone: tz }).format(d);
  const time = new Intl.DateTimeFormat("nl-NL", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).format(d);
  const cap = day.charAt(0).toUpperCase() + day.slice(1).replace(/\.$/, "");
  return `${cap} ${time}`;
}

/**
 * Distinct target-cycle names, keyed by series key. Deterministic for a given input order.
 * Single series → [roundName] verbatim.
 */
export function buildTargetCycleNames(
  roundName: string,
  series: SeriesNameInput[],
  tz: string,
): Map<string, string> {
  const out = new Map<string, string>();
  if (series.length === 0) return out;
  if (series.length === 1) {
    out.set(series[0].key, roundName);
    return out;
  }

  // Tier 1: round name + day/time label.
  const base = series.map((s) => ({ s, name: `${roundName} — ${seriesLabel(s.startIso, tz)}` }));
  const counts = (names: { name: string }[]) => {
    const m = new Map<string, number>();
    for (const n of names) m.set(n.name, (m.get(n.name) ?? 0) + 1);
    return m;
  };

  // Tier 2: same day+time (two trainers) → append the trainer name.
  let dup = counts(base);
  const withTrainer = base.map((e) =>
    (dup.get(e.name) ?? 0) > 1 && e.s.trainerName
      ? { s: e.s, name: `${e.name} · ${e.s.trainerName}` }
      : e,
  );

  // Tier 3: still colliding (same trainer/time, two locations) → append the location.
  dup = counts(withTrainer);
  const withLocation = withTrainer.map((e) =>
    (dup.get(e.name) ?? 0) > 1 && e.s.locationName
      ? { s: e.s, name: `${e.name} · ${e.s.locationName}` }
      : e,
  );

  // Tier 4: last resort — numeric suffix keeps the DB unique key satisfied no matter what.
  dup = counts(withLocation);
  const seen = new Map<string, number>();
  for (const e of withLocation) {
    let name = e.name;
    if ((dup.get(e.name) ?? 0) > 1) {
      const n = (seen.get(e.name) ?? 0) + 1;
      seen.set(e.name, n);
      if (n > 1) name = `${e.name} #${n}`;
    }
    out.set(e.s.key, name);
  }
  return out;
}
