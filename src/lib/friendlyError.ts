/**
 * Turns an arbitrary thrown value into a message that is safe to show a
 * non-technical user. Backend leakage — Postgres / PostgREST / Supabase edge
 * errors, raw object dumps, "Edge Function returned a non-2xx status code",
 * "new row violates row-level security policy" — is replaced with a translated
 * fallback. Genuinely user-facing messages the app throws on purpose (already
 * translated, e.g. "Dit tijdslot is vol") pass through unchanged.
 *
 * Use at the money and acquisition moments (checkout, signup, claim) where a
 * raw English/SQL string both confuses the user and gives them no way forward.
 */

const TECHNICAL_PATTERNS: RegExp[] = [
  /edge function/i,
  /non-2xx/i,
  /row-level security/i,
  /violates|violation/i,
  /duplicate key|unique constraint|\bconstraint\b/i,
  /pgrst|postgrest/i,
  /json object requested/i,
  /failed to fetch|networkerror|fetch error|load failed|err_/i,
  /authretryable|authapierror|fetcherror/i,
  /supabase/i,
  /null value|does not exist|invalid input syntax/i,
  /permission denied/i,
  /status code|http \d{3}/i,
  // Raw booking-enforcement RAISE codes from enforce_booking_slot_tier /
  // book_slot_for_payment — show the caller's translated fallback, never the token.
  /\b(slot_full|slot_not_released|priority_restricted|members_only)\b/i,
  // Raw RAISE code from check_trainer_slot_overlap (trainer double-booking guard).
  // Surfaces that want the specific message check isTrainerSlotOverlapError first;
  // everywhere else falls back rather than leaking the token.
  /\btrainer_slot_overlap\b/i,
  // Two overlap-guard batches racing can be resolved by Postgres aborting one —
  // a retryable condition, never something to show raw.
  /deadlock detected/i,
];

export function extractRawMessage(error: unknown): string {
  if (error == null) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object") {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error_description === "string") return obj.error_description;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.msg === "string") return obj.msg;
    try {
      return JSON.stringify(error);
    } catch {
      return "";
    }
  }
  return String(error);
}

export function isTechnicalErrorMessage(message: string): boolean {
  if (!message) return true; // nothing usable → fall back
  const trimmed = message.trim();
  // Raw object / array dumps and "[object Object]" style leakage.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return true;
  if (/\[object\s+\w+\]/i.test(trimmed)) return true;
  return TECHNICAL_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * @param error    the caught value (Error, string, Supabase error object, …)
 * @param fallback an already-translated, user-friendly message to show when the
 *                 raw error is technical/unsafe.
 */
export function getFriendlyErrorMessage(error: unknown, fallback: string): string {
  const raw = extractRawMessage(error);
  return isTechnicalErrorMessage(raw) ? fallback : raw;
}
