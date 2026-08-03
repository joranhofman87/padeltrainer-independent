// 10c-b D — the ONE typed notify-followers caller and its bounded retry.
//
// Orchestration tests: they drive the real production function with an invoke double, so the
// retry bound, the "incomplete" detection and the honest partial-failure outcome are all
// exercised as production runs them — not asserted from source text.
import { describe, it, expect } from 'vitest';
import {
  notifyFollowers,
  NOTIFY_FOLLOWERS_MAX_ATTEMPTS,
  type FunctionsClientLike,
  type NotifyFollowersBody,
} from '@/lib/notifyFollowers';

const BODY: NotifyFollowersBody = { slot_count: 3, date_from: '2026-08-10', date_to: '2026-08-16' };

/** Returns the given results in order; records every route+body it was called with. */
function invoker(results: Array<{ error: { message: string } | null } | Error>) {
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
        return { data: null, error: r.error };
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
    for (const b of inv.bodies) expect(b).toEqual(BODY);
    expect(new Set(inv.bodies.map((b) => JSON.stringify(b))).size).toBe(1);
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
