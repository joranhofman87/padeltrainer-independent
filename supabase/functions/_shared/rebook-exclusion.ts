/**
 * Trainer / session exclusion for cohort rebooking. Pure + Deno-tested; the
 * bulk-rebook-cycle edge function builds `SeriesForExclusion[]` from its qualifying
 * weekly series (each with its cohort's REGISTERED profile ids) and uses this to:
 *   • decide which series to rebook (everything not excluded), and
 *   • collect the registered players of EXCLUDED series the owner chose to move to
 *     the "second bucket" (member window) — minus anyone who is still in an included
 *     series (they already get a real priority claim, so they don't need the grant).
 *
 * Guests are never here: a series' `registeredPlayerIds` are `bookings.player_id`
 * (profile ids); guests only have `guest_player_id`, and can't self-book the member
 * window anyway. So second-bucket grants are registered-only by construction.
 */

export interface SeriesForExclusion {
  seriesKey: string;
  /** Distinct registered profile ids (bookings.player_id) in this series' cohort. */
  registeredPlayerIds: string[];
}

export interface ExclusionResult {
  includedKeys: Set<string>;
  excludedKeys: Set<string>;
  /**
   * Registered profile ids to add to the priority list (second-bucket access +
   * "sessions opened" email) — the union of the second-bucket series' registered
   * players, minus anyone who is also in an included series.
   */
  secondBucketProfileIds: string[];
}

export function computeRebookExclusion(
  series: SeriesForExclusion[],
  excludedSeriesKeys: string[],
  secondBucketSeriesKeys: string[],
): ExclusionResult {
  const allKeys = new Set(series.map((s) => s.seriesKey));
  // Only a series that actually exists AND is excluded can qualify.
  const excludedKeys = new Set(excludedSeriesKeys.filter((k) => allKeys.has(k)));
  const secondBucketKeys = new Set(
    secondBucketSeriesKeys.filter((k) => excludedKeys.has(k)),
  );
  const includedKeys = new Set([...allKeys].filter((k) => !excludedKeys.has(k)));

  // Profile ids that still have an included series → they get a real claim; never
  // spend a second-bucket slot on them.
  const includedProfileIds = new Set<string>();
  for (const s of series) {
    if (includedKeys.has(s.seriesKey)) {
      for (const pid of s.registeredPlayerIds) includedProfileIds.add(pid);
    }
  }

  const secondBucket = new Set<string>();
  for (const s of series) {
    if (!secondBucketKeys.has(s.seriesKey)) continue;
    for (const pid of s.registeredPlayerIds) {
      if (!includedProfileIds.has(pid)) secondBucket.add(pid);
    }
  }

  return { includedKeys, excludedKeys, secondBucketProfileIds: [...secondBucket] };
}
