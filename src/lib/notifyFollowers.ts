/**
 * 10c-b D — THE ONLY way the app invokes `notify-followers`.
 *
 * WHY CENTRALISED. The caller registry previously matched literal route names, so
 * `const FN = "notify-followers"; invoke(FN)` would have slipped past it. A register that can be
 * bypassed by a variable is not a control. Every invocation now goes through this one typed
 * function, and the registry asserts that NO other file reaches the route directly — which is a
 * property a grep can actually enforce.
 *
 * WHY RETRY AT ALL. `notify-followers` answers non-2xx when a run was incomplete: some
 * recipients failed to enqueue, or the wall-clock budget deferred them. Nothing re-invokes the
 * function on a schedule, and the caller previously just logged and showed a success toast — so
 * those followers were silently dropped. Retrying is SAFE and creates NO email backlog because
 * the v2 resolver de-duplicates on `<event>:<subject>:<recipient>`: a recipient already enqueued
 * by the previous attempt returns zero rows (`no_row`) and is not enqueued twice.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It never re-runs slot creation. Only the notification call
 * is retried, and only a bounded number of times; after that the caller is told the truth
 * (`complete: false`) so it can surface an honest partial state instead of a success toast.
 */

export type NotifyFollowersBody =
  | {
    slot_count: number;
    date_from: string;
    date_to: string;
    /**
     * The exact ids of the PUBLIC rows the INSERT returned. Required by the new handler: the
     * occurrence is derived from these exact rows instead of a date-range rediscovery, which was
     * both an off-by-one at day boundaries and a query able to match slots this caller never
     * created. The handler proves every id through an aggregate RPC under the JWT-derived trainer.
     */
    slot_ids: string[];
  }
  | { slot_count: number; single_slot: { date: string; time: string }; booking_id?: string };

/**
 * DEPLOY-OVERLAP: send BOTH shapes.
 *
 * The compatibility work so far only covered edge-deployed-first (the new handler accepts a
 * legacy `date_range`). The other order is just as real: the frontend deploys automatically, so
 * a NEW bundle can reach the OLD handler, which reads `date_range` — getting `undefined`, mailing
 * an undefined range and keying every later batch on the same `na:undefined` so they collapse
 * into one another. Emitting the legacy field alongside the ISO ones makes BOTH handler versions
 * understand the identical request. The new handler ignores `date_range` whenever ISO fields are
 * present, so this cannot re-introduce display-text dates.
 *
 * REMOVE together with the handler-side compatibility branch, after one rollout + cache window.
 */
export function withLegacyCompatFields(body: NotifyFollowersBody): Record<string, unknown> {
  if (!("date_from" in body)) return { ...body };
  return { ...body, date_range: legacyDateRange(body.date_from, body.date_to) };
}

/**
 * The legacy display range, and the reason it prints BOTH years when they differ.
 *
 * The historical format put the year only on the right (`Aug 10 - Aug 16, 2026`). That is
 * ambiguous the moment a batch crosses a year boundary: `Jan 1 - Jan 2, 2027` is what both
 * 2027-01-01..2027-01-02 and 2026-01-01..2027-01-02 print, and no reader can tell which was
 * meant. Bulk creation imposes no span limit — several entries, each recurring up to 52 weeks,
 * with unrelated start dates — so multi-year batches are reachable, and the old handler would
 * have keyed two different batches on the same dedup anchor. Printing both years whenever they
 * differ makes every range this app emits parse back to exactly one pair of dates.
 *
 * The pre-cutover handler treats this string as opaque display text plus a dedup anchor, so the
 * wider form is safe for it. It is byte-identical to the historical one for a same-year range,
 * which is the overwhelmingly common case and the one already in flight during the deploy.
 *
 * Kept in step with the production parser by src/test/notifyFollowersRetry.test.ts, which
 * round-trips this output through the edge function's own parseLegacyDateRange.
 */
export function legacyDateRange(fromIso: string, toIso: string): string {
  const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const part = (iso: string) => {
    const [y, m, d] = iso.split("-");
    return { y, mon: MON[Number(m) - 1], d: String(Number(d)) };
  };
  const a = part(fromIso);
  const b = part(toIso);
  return a.y === b.y
    ? `${a.mon} ${a.d} - ${b.mon} ${b.d}, ${b.y}`
    : `${a.mon} ${a.d}, ${a.y} - ${b.mon} ${b.d}, ${b.y}`;
}

/**
 * Did the run REPORT itself incomplete, whichever handler version answered?
 *
 * A 2xx is not proof of completion, and this is the direction the cutover got wrong. The
 * pre-cutover handler answers **200 for every run it survives**, putting the un-notified tail in
 * the body: `remaining` for the recipients its wall-clock budget dropped, `errors` for the sends
 * that failed. Treating any 200 as complete therefore turned a partial run into a silent success
 * and no retry ever happened. The cutover handler states it directly with `incomplete`, and
 * repeats the detail as `failed` / `deferred`.
 *
 * So completeness is judged from the BODY as well as the status, and every field either version
 * uses to express "not everyone was handled" is honoured. `legacy_marker_failed` is deliberately
 * NOT one of them: those recipients WERE enqueued, and no re-run can write the missing marker
 * (the resolver answers `no_row` for an already-enqueued recipient, which is not markable), so
 * retrying on it would be a retry that provably cannot help. It is surfaced through
 * `markerGap` instead. Unknown shapes are treated as complete — the status code has already been
 * checked by the caller, and inventing incompleteness would retry runs that genuinely finished.
 */
export function runReportedIncomplete(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const b = data as Record<string, unknown>;
  const positive = (v: unknown) => typeof v === "number" && v > 0;
  if (b.incomplete === true) return true;                              // cutover handler
  if (positive(b.remaining)) return true;                              // pre-cutover handler
  if (positive(b.failed) || positive(b.deferred)) return true;         // cutover detail
  if (Array.isArray(b.errors) && b.errors.length > 0) return true;     // both versions
  if (typeof b.error === "string" && b.error.length > 0) return true;  // error body with a 200
  return false;
}

export type NotifyFollowersOutcome = {
  /** True only when a run reported no failed and no deferred recipients. */
  complete: boolean;
  attempts: number;
  /** Redacted label for logging — never a recipient address. */
  lastError?: string;
  /**
   * Recipients enqueued WITHOUT their cross-version rollback marker. Not a delivery gap and not
   * retryable — surfaced so the caller can log it rather than discard it.
   */
  markerGap?: number;
};

/** How many recipients the run enqueued without writing the rollback marker. */
export function markerGapOf(data: unknown): number {
  if (!data || typeof data !== "object") return 0;
  const v = (data as Record<string, unknown>).legacy_marker_failed;
  return typeof v === "number" && v > 0 ? v : 0;
}

/**
 * The client surface we need. Narrow on purpose: tests drive the REAL retry logic with a double,
 * and the route name lives here and nowhere else, which is what makes the registry enforceable.
 */
export type InvokeError = {
  message: string;
  /**
   * supabase-js wraps a non-2xx in a FunctionsHttpError carrying the raw Response, and leaves
   * `data` null. Anything the handler reported in the BODY of an error response — the marker gap
   * among it — is reachable only through here.
   */
  context?: { json?: () => Promise<unknown> };
};

export type FunctionsClientLike = {
  functions: {
    invoke: (
      name: string,
      args: { body: unknown; headers?: Record<string, string> },
    ) => Promise<{ data: unknown; error: InvokeError | null }>;
  };
};

/**
 * The marker gap for one attempt, from wherever the client put it.
 *
 * On a 2xx it is in `data`. On a non-2xx `data` is null and the body lives on the error's
 * Response — which is exactly the case that matters, because a run with BOTH an enqueue failure
 * and a failed marker write answers 500, and the next attempt sees `no_row` for those recipients
 * and reports nothing at all. Reading only `data` therefore dropped the warning in the one
 * situation it existed for. A body that cannot be read is worth zero, never an exception.
 */
export async function markerGapFromResult(
  result: { data: unknown; error: InvokeError | null },
): Promise<number> {
  const fromData = markerGapOf(result.data);
  if (fromData > 0) return fromData;
  const json = result.error?.context?.json;
  if (typeof json !== "function") return 0;
  try {
    return markerGapOf(await json.call(result.error!.context));
  } catch {
    return 0;
  }
}

/** THE route name. It must not appear anywhere else in the app. */
const ROUTE = "notify-followers";

export const NOTIFY_FOLLOWERS_MAX_ATTEMPTS = 3;

/**
 * Invoke notify-followers, retrying a bounded number of times while the run reports itself
 * incomplete.
 *
 * supabase-js turns a non-2xx into a RETURNED `{ error }` rather than a thrown exception, which
 * is exactly why the previous try/catch never saw it — so this inspects `error` explicitly.
 */
export async function notifyFollowers(
  body: NotifyFollowersBody,
  opts: {
    client: FunctionsClientLike;
    accessToken?: string;
    maxAttempts?: number;
  },
): Promise<NotifyFollowersOutcome> {
  const maxAttempts = opts.maxAttempts ?? NOTIFY_FOLLOWERS_MAX_ATTEMPTS;
  const invoke = () =>
    opts.client.functions.invoke(ROUTE, {
      body: withLegacyCompatFields(body),
      ...(opts.accessToken ? { headers: { Authorization: `Bearer ${opts.accessToken}` } } : {}),
    });
  let lastError: string | undefined;
  // SUMMED across attempts. A gap reported by attempt 1 cannot reappear on attempt 2 — those
  // recipients answer `no_row` the second time — so the gaps from different attempts are
  // disjoint sets of recipients, and taking the maximum would undercount them. Keeping it only
  // when the SAME attempt completed threw the warning away entirely in the case it mattered: an
  // incomplete first attempt that also failed its marker writes.
  let markerGap = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let result: { data: unknown; error: { message: string } | null };
    try {
      result = await invoke();
    } catch (e) {
      // A thrown transport error is retryable on the same terms.
      lastError = e instanceof Error ? e.message : "invoke_threw";
      if (attempt === maxAttempts) {
        return { complete: false, attempts: attempt, lastError, ...(markerGap ? { markerGap } : {}) };
      }
      continue;
    }

    // BOTH signals matter. A non-2xx arrives as `error`; a pre-cutover handler reports its
    // un-notified tail in the BODY of a 200. Ignoring the body is what let a partial legacy run
    // look complete and skip the retry entirely.
    markerGap += await markerGapFromResult(result);
    if (!result.error && !runReportedIncomplete(result.data)) {
      return { complete: true, attempts: attempt, ...(markerGap ? { markerGap } : {}) };
    }

    lastError = result.error?.message ?? "run_reported_incomplete";
    if (attempt === maxAttempts) {
      return { complete: false, attempts: attempt, lastError, ...(markerGap ? { markerGap } : {}) };
    }
  }

  // Unreachable for maxAttempts >= 1; keeps the function total for a caller passing 0.
  return { complete: false, attempts: 0, lastError, ...(markerGap ? { markerGap } : {}) };
}
