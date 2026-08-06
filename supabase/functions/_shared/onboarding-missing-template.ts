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
import { notifySlackEdgeError } from "./edge-slack.ts";

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

// ---------------------------------------------------------------------------
// THE RUN TALLY AND ITS ONE ALERT.
//
// The ownership CAS above only prevents double-counting if the count it feeds is
// the same count the alert is derived from. That wiring — outcome → tally → the
// single end-of-run notifySlackEdgeError — used to live inline in
// process-onboarding-emails/index.ts, where `serve(handler)` at module scope makes
// it unimportable, so the proof re-derived "alerts = failCount > 0 ? 1 : 0" in the
// test. A test-local formula stays green if production stops calling
// notifySlackEdgeError, or stops routing countsAsFailure into failCount.
//
// So the tally and the emission live here, in production code the handler calls and
// the suite imports. Deleting the `notify(...)` call below, or severing
// countsAsFailure from the tally, drops the observed alert count to zero and fails
// the suite.

/** The counts one invocation accumulates; `failCount` is what arms the alert. `suppressedCount`
 *  (N2 S3) counts marketing rows refused by a send-time opt-out — deliberately NOT part of
 *  `failCount`: a suppression is the system working, and alerting on it would train the operator
 *  to ignore the alert. */
export type OnboardingRunTally = {
  failCount: number;
  successCount: number;
  suppressedCount: number;
  processed: number;
};

export function newOnboardingRunTally(processed = 0): OnboardingRunTally {
  return { failCount: 0, successCount: 0, suppressedCount: 0, processed };
}

/**
 * Fold one missing-template outcome into the run tally. This is THE link between
 * ownership and alerting: only an outcome this invocation owns (or a genuine write
 * error) may raise `failCount`.
 */
export function recordMissingTemplateOutcome(
  tally: OnboardingRunTally,
  outcome: MissingTemplateOutcome,
): void {
  if (countsAsFailure(outcome)) tally.failCount++;
}

/** The alert transport shape (structurally `notifySlackEdgeError`). */
export type RunAlertNotifier = (
  functionName: string,
  errorMessage: string,
  context?: Record<string, unknown>,
) => Promise<void>;

/**
 * The production transport. Exported so a test can assert the default has not been
 * swapped for a no-op — an injected spy alone cannot see that substitution.
 */
export const DEFAULT_RUN_ALERT_NOTIFIER: RunAlertNotifier = notifySlackEdgeError;

/**
 * Emit the single end-of-run operator alert, if this invocation tallied any failure.
 *
 * Per-item failures return HTTP 200, so the daily-emails cron wrapper's
 * alertCronFailure (non-2xx only) never sees them, and each failed item is already
 * marked 'failed' in the queue (it will not retry) — a silent failure is an
 * onboarding email that never goes out. Returns whether an alert was emitted.
 */
export async function emitOnboardingRunAlert(
  tally: OnboardingRunTally,
  notify: RunAlertNotifier = DEFAULT_RUN_ALERT_NOTIFIER,
): Promise<boolean> {
  if (tally.failCount <= 0) return false;
  await notify(
    "process-onboarding-emails",
    `${tally.failCount} onboarding email(s) failed to send`,
    {
      failCount: tally.failCount,
      successCount: tally.successCount,
      processed: tally.processed,
    },
  );
  return true;
}
