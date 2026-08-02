/**
 * Ownership of a missing-template onboarding queue failure.
 *
 * WHY THIS IS A SHARED PRIMITIVE AND NOT INLINE HANDLER CODE.
 * The missing-template branch of process-onboarding-emails runs BEFORE
 * claim_onboarding_email_queue_item, so it is the one place in that worker where
 * two overlapping invocations can both act on the same row. It used to update the
 * row keyed on id alone, so both runs wrote 'failed', both counted a failure, and
 * because the failure count is what triggers the Slack alert, ONE broken row
 * produced TWO operator alerts. Removing the cron single-flight lock (CRON-SF-WEDGE)
 * made that overlap reachable rather than theoretical.
 *
 * The guard therefore lives here, in ONE production-owned function, so the test
 * suite exercises the real thing rather than a hand-copied approximation of it.
 * Deleting `.eq("status", "pending")` below is what a mutation test must break.
 */

/** The minimal client surface this primitive needs (keeps it trivially testable). */
export type MissingTemplateClient = {
  from: (table: string) => {
    update: (values: Record<string, unknown>) => {
      eq: (col: string, val: unknown) => {
        eq: (col: string, val: unknown) => {
          select: (cols: string) => Promise<{ data: Array<{ id: string }> | null; error: { message: string } | null }>;
        };
      };
    };
  };
};

export type MissingTemplateOutcome =
  /** This invocation transitioned the row and OWNS the failure (count it, alert on it). */
  | { kind: "owned" }
  /** Another invocation already owns it. Stay silent — counting here double-alerts. */
  | { kind: "already_handled" }
  /** The write itself failed. A genuine error must stay visible, never be mistaken
   *  for "someone else owns it", which would silently drop a real fault. */
  | { kind: "error"; message: string };

/**
 * Atomically take ownership of the missing-template failure for one queue row.
 *
 * The CAS is `WHERE id = ? AND status = 'pending'` with the affected rows read
 * back: exactly one concurrent caller can observe a row, so exactly one counts the
 * failure and exactly one alert is emitted for it.
 */
export async function claimMissingTemplateFailure(
  supabase: MissingTemplateClient,
  queueId: string,
): Promise<MissingTemplateOutcome> {
  const { data, error } = await supabase
    .from("onboarding_email_queue")
    .update({ status: "failed", error_message: "Template not found" })
    .eq("id", queueId)
    .eq("status", "pending")
    .select("id");

  if (error) return { kind: "error", message: error.message };
  if (!data || data.length === 0) return { kind: "already_handled" };
  return { kind: "owned" };
}

/**
 * Does this outcome contribute to the invocation's failure tally (and therefore to
 * its single end-of-run Slack alert)? Centralised so the accounting rule cannot
 * drift away from the ownership rule.
 */
export function countsAsFailure(outcome: MissingTemplateOutcome): boolean {
  return outcome.kind === "owned" || outcome.kind === "error";
}
