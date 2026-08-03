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
  | { slot_count: number; date_from: string; date_to: string }
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
  const fmt = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return { day: String(d), mon: MON[m - 1], year: String(y) };
  };
  const a = fmt(body.date_from);
  const b = fmt(body.date_to);
  return { ...body, date_range: `${a.mon} ${a.day} - ${b.mon} ${b.day}, ${b.year}` };
}

export type NotifyFollowersOutcome = {
  /** True only when a run reported no failed and no deferred recipients. */
  complete: boolean;
  attempts: number;
  /** Redacted label for logging — never a recipient address. */
  lastError?: string;
};

/**
 * The client surface we need. Narrow on purpose: tests drive the REAL retry logic with a double,
 * and the route name lives here and nowhere else, which is what makes the registry enforceable.
 */
export type FunctionsClientLike = {
  functions: {
    invoke: (
      name: string,
      args: { body: unknown; headers?: Record<string, string> },
    ) => Promise<{ data: unknown; error: { message: string } | null }>;
  };
};

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

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let result: { data: unknown; error: { message: string } | null };
    try {
      result = await invoke();
    } catch (e) {
      // A thrown transport error is retryable on the same terms.
      lastError = e instanceof Error ? e.message : "invoke_threw";
      if (attempt === maxAttempts) return { complete: false, attempts: attempt, lastError };
      continue;
    }

    if (!result.error) return { complete: true, attempts: attempt };

    lastError = result.error.message;
    if (attempt === maxAttempts) return { complete: false, attempts: attempt, lastError };
  }

  // Unreachable for maxAttempts >= 1; keeps the function total for a caller passing 0.
  return { complete: false, attempts: 0, lastError };
}
