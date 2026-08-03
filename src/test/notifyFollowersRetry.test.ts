// 10c-b D — the ONE typed notify-followers caller and its bounded retry.
//
// Orchestration tests: they drive the real production function with an invoke double, so the
// retry bound, the "incomplete" detection and the honest partial-failure outcome are all
// exercised as production runs them — not asserted from source text.
import { describe, it, expect } from 'vitest';
import {
  notifyFollowers,
  legacyDateRange,
  runReportedIncomplete,
  NOTIFY_FOLLOWERS_MAX_ATTEMPTS,
  type FunctionsClientLike,
  type NotifyFollowersBody,
} from '@/lib/notifyFollowers';
// The EDGE FUNCTION's own parser — the other side of the wire. Importing it is what makes the
// round-trip assertions below real rather than a restatement of the formatter's output.
import {
  formatLegacyDateRange,
  parseLegacyDateRange,
} from '../../supabase/functions/_shared/open-slots-notify';

const BODY: NotifyFollowersBody = { slot_count: 3, date_from: '2026-08-10', date_to: '2026-08-16' };

type InvokeResult = { error: { message: string } | null; data?: unknown };

/** Returns the given results in order; records every route+body it was called with. */
function invoker(results: Array<InvokeResult | Error>) {
  const bodies: NotifyFollowersBody[] = [];
  const routes: string[] = [];
  let i = 0;
  const client: FunctionsClientLike = {
    functions: {
      invoke: async (name, args) => {
        routes.push(name);
        bodies.push(args.body as NotifyFollowersBody);
        const r = results[Math.min(i, results.length - 1)];
        i++;
        if (r instanceof Error) throw r;
        return { data: r.data ?? null, error: r.error };
      },
    },
  };
  return { client, bodies, routes, calls: () => i };
}

describe('notifyFollowers — bounded, idempotency-safe retry', () => {
  it('a complete run does not retry', async () => {
    const inv = invoker([{ error: null }]);
    const out = await notifyFollowers(BODY, { client: inv.client });
    expect(out).toEqual({ complete: true, attempts: 1 });
    expect(inv.calls()).toBe(1);
  });

  it('retries while the run reports itself INCOMPLETE, then succeeds', async () => {
    // supabase-js turns a non-2xx into a returned { error }, which is exactly why the previous
    // try/catch never saw it. Retrying is safe: the resolver de-duplicates per recipient, so a
    // follower already enqueued on attempt 1 is a no-op on attempt 2 — no email backlog.
    const inv = invoker([
      { error: { message: 'incomplete' } },
      { error: null },
    ]);
    const out = await notifyFollowers(BODY, { client: inv.client });
    expect(out).toEqual({ complete: true, attempts: 2 });
    expect(inv.calls()).toBe(2);
  });

  it('gives up after the bound and reports an HONEST partial failure', async () => {
    const inv = invoker([{ error: { message: 'incomplete' } }]);
    const out = await notifyFollowers(BODY, { client: inv.client });
    expect(out.complete).toBe(false);
    expect(out.attempts).toBe(NOTIFY_FOLLOWERS_MAX_ATTEMPTS);
    expect(out.lastError).toBe('incomplete');
    expect(inv.calls()).toBe(NOTIFY_FOLLOWERS_MAX_ATTEMPTS);
  });

  it('is BOUNDED — it can never loop indefinitely against a persistently failing run', async () => {
    const inv = invoker([{ error: { message: 'always down' } }]);
    await notifyFollowers(BODY, { client: inv.client, maxAttempts: 5 });
    expect(inv.calls()).toBe(5);
  });

  it('a THROWN transport error is retried on the same terms', async () => {
    const inv = invoker([new Error('network'), { error: null }]);
    const out = await notifyFollowers(BODY, { client: inv.client });
    expect(out).toEqual({ complete: true, attempts: 2 });
  });

  it('a persistently thrown error still terminates with an honest outcome', async () => {
    const inv = invoker([new Error('network')]);
    const out = await notifyFollowers(BODY, { client: inv.client });
    expect(out.complete).toBe(false);
    expect(out.lastError).toBe('network');
    expect(inv.calls()).toBe(NOTIFY_FOLLOWERS_MAX_ATTEMPTS);
  });

  it('every retry sends the IDENTICAL body — same idempotency subject, so no duplicates', async () => {
    // If a retry varied the body, the resolver would derive a DIFFERENT subject and enqueue a
    // second notification for everyone who already got one. That is the backlog this must avoid.
    const inv = invoker([{ error: { message: 'incomplete' } }]);
    await notifyFollowers(BODY, { client: inv.client });
    expect(inv.bodies).toHaveLength(NOTIFY_FOLLOWERS_MAX_ATTEMPTS);
    // The body is augmented with the legacy compat field before sending, so compare the retries
    // to EACH OTHER — identical across attempts is what keeps the idempotency subject stable.
    expect(new Set(inv.bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    for (const b of inv.bodies) {
      expect((b as unknown as Record<string, unknown>).date_from).toBe('2026-08-10');
    }
  });

  it('slot creation is never repeated — this function only ever calls notify-followers', async () => {
    // The function receives ONE invoke closure and calls only that; there is no path by which a
    // retry could re-run the surrounding bulk-create workflow.
    const inv = invoker([{ error: { message: 'incomplete' } }]);
    await notifyFollowers(BODY, { client: inv.client });
    expect(inv.bodies.every((b) => 'slot_count' in b)).toBe(true);
    // and it only ever calls the one route
    expect(new Set(inv.routes)).toEqual(new Set(['notify-followers']));
  });

  // MUTATION PINS
  it('MUTANT: an unbounded retry loop never terminates against a failing run', async () => {
    let mutantCalls = 0;
    const mutantBounded = async (limit: number) => {
      while (mutantCalls < limit) mutantCalls++;   // stands in for `while (!complete)`
      return mutantCalls;
    };
    expect(await mutantBounded(50)).toBe(50);      // the mutant keeps going...
    const inv = invoker([{ error: { message: 'incomplete' } }]);
    await notifyFollowers(BODY, { client: inv.client });
    expect(inv.calls()).toBeLessThanOrEqual(NOTIFY_FOLLOWERS_MAX_ATTEMPTS);   // ...production stops
  });

  it('MUTANT: reporting complete=true on error would hide every dropped recipient', async () => {
    const mutant = () => ({ complete: true });
    expect(mutant().complete).toBe(true);
    const inv = invoker([{ error: { message: 'incomplete' } }]);
    const out = await notifyFollowers(BODY, { client: inv.client });
    expect(out.complete).toBe(false);
    expect(out.complete === mutant().complete).toBe(false);
  });
});

describe('deploy-overlap compatibility', () => {
  it('sends BOTH the ISO fields and the legacy date_range', async () => {
    // The frontend deploys automatically, so a NEW bundle can reach the OLD handler, which reads
    // date_range — getting undefined, mailing an undefined range, and keying every later batch
    // on the same `na:undefined` so they collapse together. Emitting both shapes makes either
    // handler version understand the identical request.
    const inv = invoker([{ error: null }]);
    await notifyFollowers({ slot_count: 3, date_from: '2026-08-10', date_to: '2026-08-16' },
      { client: inv.client });
    const sent = inv.bodies[0] as unknown as Record<string, unknown>;
    expect(sent.date_from).toBe('2026-08-10');
    expect(sent.date_to).toBe('2026-08-16');
    expect(sent.date_range).toBe('Aug 10 - Aug 16, 2026');
  });

  it('the emitted legacy range ACTUALLY round-trips through the edge parser', async () => {
    // Asserting the printed string only proves the formatter agrees with itself. The property
    // that matters is that the HANDLER's parser recovers the identical dates — otherwise the two
    // versions derive different idempotency subjects and the overlap double-notifies. So the
    // emitted value is fed back through the production parser, for every shape that has bitten:
    // a plain range, a New Year crossing, a same-month 52-week series, and a multi-year batch.
    const cases: Array<[string, string]> = [
      ['2026-08-10', '2026-08-16'],
      ['2026-08-10', '2026-08-10'],
      ['2026-12-29', '2027-01-05'],
      ['2026-01-10', '2027-01-02'],
      ['2026-01-01', '2027-01-02'],
      ['2026-03-01', '2029-11-30'],
    ];
    for (const [date_from, date_to] of cases) {
      const inv = invoker([{ error: null }]);
      await notifyFollowers({ slot_count: 1, date_from, date_to }, { client: inv.client });
      const sent = inv.bodies[0] as unknown as Record<string, unknown>;
      expect(typeof sent.date_range).toBe('string');
      expect(parseLegacyDateRange(sent.date_range as string), `${date_from}..${date_to}`)
        .toEqual({ from: date_from, to: date_to });
    }
  });

  it('the app-side formatter is byte-identical to the edge functions own', () => {
    // The two live in different runtimes and cannot share a module without pulling edge code
    // into the browser bundle, so the equivalence is PINNED by executing both. A drift here is
    // exactly what would make the legacy dedup bridge stop matching.
    for (const [from, to] of [
      ['2026-08-10', '2026-08-16'],
      ['2026-12-29', '2027-01-05'],
      ['2026-01-01', '2027-01-02'],
      ['2026-01-10', '2027-01-02'],
      ['2026-02-29', '2026-03-01'],
    ]) {
      expect(legacyDateRange(from, to)).toBe(formatLegacyDateRange(from, to));
    }
  });

  it('a year-crossing range prints BOTH years, so it can only mean one thing', () => {
    // The historical format put the year on the right only. "Jan 1 - Jan 2, 2027" is what both
    // 2027-01-01..2027-01-02 and 2026-01-01..2027-01-02 print, and the bulk form can produce
    // either (several entries, each up to 52 weeks, with unrelated start dates).
    expect(legacyDateRange('2026-01-01', '2027-01-02')).toBe('Jan 1, 2026 - Jan 2, 2027');
    expect(legacyDateRange('2026-08-10', '2026-08-16')).toBe('Aug 10 - Aug 16, 2026');
    // MUTATION PIN: the old single-year emission round-trips to the WRONG range.
    expect(parseLegacyDateRange('Jan 1 - Jan 2, 2027')).toEqual({ from: '2027-01-01', to: '2027-01-02' });
    expect(parseLegacyDateRange(legacyDateRange('2026-01-01', '2027-01-02')))
      .toEqual({ from: '2026-01-01', to: '2027-01-02' });
  });

  it('a PRE-CUTOVER 200 that reports a deferred tail is treated as INCOMPLETE', async () => {
    // The old handler answers 200 for every run it survives and puts the un-notified tail in the
    // body as `remaining`. Judging completeness from the status alone made a partial legacy run
    // look finished, so nothing retried and those followers were lost.
    const inv = invoker([
      { error: null, data: { message: 'Notified 10 followers', sent: 10, remaining: 240 } },
      { error: null, data: { message: 'Notified 240 followers', sent: 240, remaining: 0 } },
    ]);
    const out = await notifyFollowers(BODY, { client: inv.client });
    expect(out).toEqual({ complete: true, attempts: 2 });
  });

  it('a PRE-CUTOVER 200 carrying send errors is treated as INCOMPLETE', async () => {
    const inv = invoker([{ error: null, data: { sent: 3, remaining: 0, errors: ['Failed to email x'] } }]);
    const out = await notifyFollowers(BODY, { client: inv.client });
    expect(out.complete).toBe(false);
    expect(out.attempts).toBe(NOTIFY_FOLLOWERS_MAX_ATTEMPTS);
    expect(out.lastError).toBe('run_reported_incomplete');
  });

  it('a CUTOVER body that says incomplete is honoured even on a 200', async () => {
    const inv = invoker([{ error: null, data: { incomplete: true, enqueued: 5, deferred: 7, failed: 0 } }]);
    expect((await notifyFollowers(BODY, { client: inv.client })).complete).toBe(false);
  });

  it('a failed rollback marker is retried — the enqueues landed, the guard did not', async () => {
    // Every recipient was enqueued, so this is not a delivery gap; but the cross-version rollback
    // guard is missing for them and only another pass can write it. Re-running is free of
    // duplicates because the resolver de-duplicates the enqueues.
    const inv = invoker([
      { error: null, data: { incomplete: true, enqueued: 5, deferred: 0, failed: 0, legacy_marker_failed: 5 } },
      { error: null, data: { incomplete: false, enqueued: 0, deferred: 0, failed: 0, no_row: 5 } },
    ]);
    expect(await notifyFollowers(BODY, { client: inv.client })).toEqual({ complete: true, attempts: 2 });
    expect(runReportedIncomplete({ legacy_marker_failed: 1 })).toBe(true);
    expect(runReportedIncomplete({ legacy_marker_failed: 0 })).toBe(false);
  });

  it('a genuinely complete run of EITHER version is not retried', () => {
    // The judgement itself, exercised directly on both response shapes.
    expect(runReportedIncomplete({ message: 'Notified 10 followers', sent: 10, remaining: 0 })).toBe(false);
    expect(runReportedIncomplete({
      incomplete: false, continued: false,
      enqueued: 10, skipped: 0, no_row: 2, failed: 0, deferred: 0, already_sent_legacy: 0,
    })).toBe(false);
    expect(runReportedIncomplete(null)).toBe(false);
    expect(runReportedIncomplete('not json')).toBe(false);
    // ...and every way either version expresses "not everyone was handled"
    expect(runReportedIncomplete({ remaining: 1 })).toBe(true);
    expect(runReportedIncomplete({ deferred: 1 })).toBe(true);
    expect(runReportedIncomplete({ failed: 1 })).toBe(true);
    expect(runReportedIncomplete({ incomplete: true })).toBe(true);
    expect(runReportedIncomplete({ errors: ['boom'] })).toBe(true);
    expect(runReportedIncomplete({ error: 'follower_lookup_failed' })).toBe(true);
  });

  it('MUTANT: judging completeness from the STATUS alone drops the legacy tail', async () => {
    const legacyPartial = { sent: 10, remaining: 240 };
    const mutant = (r: { error: unknown }) => !r.error;                  // status-only judgement
    expect(mutant({ error: null })).toBe(true);                          // the mutant stops here...
    const inv = invoker([{ error: null, data: legacyPartial }]);
    const out = await notifyFollowers(BODY, { client: inv.client });
    expect(out.complete).toBe(false);                                    // ...production retries
    expect(inv.calls()).toBe(NOTIFY_FOLLOWERS_MAX_ATTEMPTS);
  });

  it('a reopened-slot body carries no legacy range (it never had one)', async () => {
    const inv = invoker([{ error: null }]);
    await notifyFollowers({ slot_count: 1, single_slot: { date: '2026-08-10', time: '18:30' } },
      { client: inv.client });
    expect((inv.bodies[0] as unknown as Record<string, unknown>).date_range).toBeUndefined();
  });
});
