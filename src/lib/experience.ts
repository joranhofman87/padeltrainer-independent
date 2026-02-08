/**
 * Calculate years of experience from the year a trainer started coaching.
 * Returns null if no coaching_since_year is provided.
 */
export function getExperienceYears(coachingSinceYear: number | null | undefined): number | null {
  if (coachingSinceYear == null) return null;
  return Math.max(0, new Date().getFullYear() - coachingSinceYear);
}
