// @vitest-environment node
/**
 * U1b — plan construction, applier input validation, and session-lease ownership.
 *
 * The database-level behaviour (batching, resume, idempotence, rollback) is proven against real
 * Postgres by `scripts/db/rehearse-u1b-membership-backfill.mjs`. What lives here is everything that
 * must hold BEFORE a statement is issued: the contract checks that stop a malformed plan from ever
 * reaching the write path, and the lease discipline that stops a hostile or broken client from
 * costing us a connection.
 *
 * Every rejection asserted here is a contract violation rather than a data condition. Bad data is
 * supposed to arrive as an unresolved disposition; if it turns up as a malformed *eligible* row, the
 * inventory and the planner disagree about the contract, and continuing would write rows nobody
 * classified.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildBackfillPlan, planHashOf, PLAN_VERSION, contentHash } from '../../scripts/db/u1b-backfill-plan.mjs';
import { applyBackfillPlan } from '../../scripts/db/u1b-backfill-apply.mjs';
import { acquireLease } from '../../scripts/db/session-lease.mjs';

const AS_OF = '2026-08-08T00:00:00Z';
const ACADEMY = '11111111-1111-4111-8111-111111111111';
const ACADEMY2 = '22222222-2222-4222-8222-222222222222';
const PERSON = '33333333-3333-4333-8333-333333333333';
const PERSON2 = '44444444-4444-4444-8444-444444444444';

/**
 * A minimal, well-formed inventory result — including a REAL content_hash, computed the same way the
 * inventory computes it. The planner recomputes and verifies that hash, so a fixture with a made-up
 * one would be rejected as tampered (which is the point).
 */
const inventoryOf = (dispositions: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) => {
  const counts: Record<string, number> = {};
  for (const d of dispositions) counts[d.disposition as string] = (counts[d.disposition as string] ?? 0) + 1;
  const body = {
    inventory_version: 'u1a.1',
    as_of: AS_OF,
    disposition_counts: counts,
    total_candidates: dispositions.length,
    report: { dispositions },
    ...overrides,
  };
  return { ...body, content_hash: contentHash(body), mutation_free: true, ...overrides };
};

const eligible = (academy: string, person: string, subject = 'g1') => ({
  academy_profile_id: academy, subject_kind: 'guest', subject_id: subject,
  person_id: person, paths: ['S1_metadata_row'], disposition: 'eligible',
});

describe('buildBackfillPlan — the plan itself', () => {
  it('plans exactly the DISTINCT eligible pairs, in total order', () => {
    const plan = buildBackfillPlan(inventoryOf([
      eligible(ACADEMY2, PERSON2, 'g3'),
      eligible(ACADEMY, PERSON, 'g1'),
      eligible(ACADEMY, PERSON, 'g2'),        // same pair, different subject → ONE row
      { ...eligible(ACADEMY, PERSON2, 'g4'), disposition: 'unresolved_split_frozen' },
    ]));

    expect(plan.rows).toEqual([
      { academy_profile_id: ACADEMY, person_id: PERSON },
      { academy_profile_id: ACADEMY2, person_id: PERSON2 },
    ]);
    expect(plan.planned_row_count).toBe(2);
    expect(plan.plan_version).toBe(PLAN_VERSION);
  });

  it('reports the collision gap instead of hiding it', () => {
    const plan = buildBackfillPlan(inventoryOf([
      eligible(ACADEMY, PERSON, 'g1'),
      eligible(ACADEMY, PERSON, 'g2'),
    ]));
    expect(plan.reconciliation).toMatchObject({
      eligible_candidates: 2, planned_rows: 1, collision_delta: 1,
    });
  });

  it('derives the unresolved classes from the inventory rather than a list of its own', () => {
    // A disposition this file has never heard of must still be counted as unresolved.
    const plan = buildBackfillPlan(inventoryOf([
      eligible(ACADEMY, PERSON),
      { ...eligible(ACADEMY2, PERSON2, 'g9'), disposition: 'unresolved_some_future_class' },
    ]));
    expect(plan.reconciliation.unresolved_by_class).toEqual({ unresolved_some_future_class: 1 });
    expect(plan.reconciliation.unresolved_candidates).toBe(1);
    expect(plan.rows).toHaveLength(1);
  });

  it('is stable: the same input yields the same hash', () => {
    const a = buildBackfillPlan(inventoryOf([eligible(ACADEMY, PERSON)]));
    const b = buildBackfillPlan(inventoryOf([eligible(ACADEMY, PERSON)]));
    expect(a.plan_hash).toBe(b.plan_hash);
    expect(planHashOf(a)).toBe(a.plan_hash);
  });

  it('changes hash when the planned set changes', () => {
    const a = buildBackfillPlan(inventoryOf([eligible(ACADEMY, PERSON)]));
    const b = buildBackfillPlan(inventoryOf([eligible(ACADEMY, PERSON), eligible(ACADEMY2, PERSON2, 'g2')]));
    expect(a.plan_hash).not.toBe(b.plan_hash);
  });

  it('changes hash when only the snapshot parameter changes', () => {
    const a = buildBackfillPlan(inventoryOf([eligible(ACADEMY, PERSON)]));
    const b = buildBackfillPlan(inventoryOf([eligible(ACADEMY, PERSON)], { as_of: '2026-08-09T00:00:00Z' }));
    expect(a.plan_hash).not.toBe(b.plan_hash);
  });
});

describe('buildBackfillPlan — contract violations are refused, never planned around', () => {
  it('refuses an inventory that reported source mutation', () => {
    expect(() => buildBackfillPlan(inventoryOf([eligible(ACADEMY, PERSON)], { mutation_free: false })))
      .toThrow(/mutation/i);
  });

  it('refuses when the disposition counts do not sum to the candidate total', () => {
    const inv = inventoryOf([eligible(ACADEMY, PERSON)]);
    inv.disposition_counts.eligible = 5;                 // histogram now lies
    expect(() => buildBackfillPlan(inv)).toThrow(/partition/i);
  });

  it('refuses a histogram that sums correctly but lies class by class', () => {
    // The dangerous shape: totals agree, so a sum-only check passes, while `eligible` — the one class
    // this module acts on — has been inflated at another class's expense.
    const inv = inventoryOf([
      eligible(ACADEMY, PERSON),
      { ...eligible(ACADEMY2, PERSON2, 'g2'), disposition: 'unresolved_split_frozen' },
    ]);
    inv.disposition_counts = { eligible: 2 };
    inv.content_hash = contentHash({
      inventory_version: inv.inventory_version, as_of: inv.as_of,
      disposition_counts: inv.disposition_counts, total_candidates: inv.total_candidates,
      report: inv.report,
    });
    expect(() => buildBackfillPlan(inv)).toThrow(/class by class/i);
  });

  it('refuses when total_candidates disagrees with the row list', () => {
    const inv = inventoryOf([eligible(ACADEMY, PERSON)]);
    inv.total_candidates = 2;
    expect(() => buildBackfillPlan(inv)).toThrow(/does not match/i);
  });

  it("refuses an inventory whose content_hash does not match its own contents", () => {
    // Provenance, not self-consistency: without recomputing this hash a hand-assembled object could
    // hand over an arbitrary eligible set and every downstream check would still agree with itself.
    const inv = inventoryOf([eligible(ACADEMY, PERSON)]);
    inv.content_hash = 'deadbeef';
    expect(() => buildBackfillPlan(inv)).toThrow(/content_hash/i);
  });

  it('refuses an inventory shape it was not written against', () => {
    const inv = inventoryOf([eligible(ACADEMY, PERSON)], { inventory_version: 'u1a.99' });
    expect(() => buildBackfillPlan(inv)).toThrow(/not the supported/i);
  });

  it('refuses an eligible candidate with no person (it should have been quarantined)', () => {
    const inv = inventoryOf([{ ...eligible(ACADEMY, PERSON), person_id: null }]);
    expect(() => buildBackfillPlan(inv)).toThrow(/no valid person_id/i);
  });

  it('refuses an eligible candidate whose person is not a UUID', () => {
    const inv = inventoryOf([{ ...eligible(ACADEMY, PERSON), person_id: 'not-a-uuid' }]);
    expect(() => buildBackfillPlan(inv)).toThrow(/no valid person_id/i);
  });

  it('refuses an eligible candidate with no academy', () => {
    const inv = inventoryOf([{ ...eligible(ACADEMY, PERSON), academy_profile_id: null }]);
    expect(() => buildBackfillPlan(inv)).toThrow(/academy_profile_id/i);
  });

  it('refuses obviously malformed inventories', () => {
    expect(() => buildBackfillPlan(null as never)).toThrow();
    expect(() => buildBackfillPlan({} as never)).toThrow();
    expect(() => buildBackfillPlan(inventoryOf([]) as never && { inventory_version: 'x' } as never)).toThrow();
  });
});

describe('applyBackfillPlan — refuses before it touches the database', () => {
  // A source that would EXPLODE if used, so any test reaching connect() fails loudly rather than
  // silently proving nothing.
  const forbidden = { connect: () => { throw new Error('connect() must not be reached'); } };

  it('refuses a plan whose stored hash no longer matches its contents', async () => {
    const plan = buildBackfillPlan(inventoryOf([eligible(ACADEMY, PERSON)]));
    plan.rows.push({ academy_profile_id: ACADEMY2, person_id: PERSON2 });   // tampered after build
    await expect(applyBackfillPlan(forbidden as never, { plan }))
      .rejects.toMatchObject({ code: 'PLAN_HASH_MISMATCH' });
  });

  it('refuses a plan with no hash at all instead of waving it through', async () => {
    // Absence used to mean "nothing to check" — a fail-open that let an unhashed, provenance-free
    // object reach the write path.
    const plan = buildBackfillPlan(inventoryOf([eligible(ACADEMY, PERSON)]));
    delete (plan as { plan_hash?: string }).plan_hash;
    await expect(applyBackfillPlan(forbidden as never, { plan }))
      .rejects.toMatchObject({ code: 'PLAN_HASH_MISSING' });
  });

  it('refuses a plan containing the same pair twice', async () => {
    const plan = buildBackfillPlan(inventoryOf([eligible(ACADEMY, PERSON)]));
    plan.rows.push({ academy_profile_id: ACADEMY, person_id: PERSON });
    plan.plan_hash = planHashOf(plan);     // re-pin, so the duplicate check is what fires
    await expect(applyBackfillPlan(forbidden as never, { plan }))
      .rejects.toMatchObject({ code: 'DUPLICATE_PLAN_ROW' });
  });

  it('refuses a malformed plan row', async () => {
    // Re-pinned after the corruption, so the hash checks pass and the row validation is what fires.
    const plan = buildBackfillPlan(inventoryOf([eligible(ACADEMY, PERSON)]));
    plan.rows = [{ academy_profile_id: ACADEMY }] as never;
    plan.plan_hash = planHashOf(plan);
    await expect(applyBackfillPlan(forbidden as never, { plan }))
      .rejects.toMatchObject({ code: 'INVALID_PLAN' });
  });

  it('refuses a non-positive or non-integer batch size', async () => {
    const plan = buildBackfillPlan(inventoryOf([eligible(ACADEMY, PERSON)]));
    for (const batchSize of [0, -1, 1.5, Number.NaN]) {
      await expect(applyBackfillPlan(forbidden as never, { plan, batchSize }))
        .rejects.toMatchObject({ code: 'INVALID_BATCH_SIZE' });
    }
  });

  it('refuses a non-positive maxBatches', async () => {
    const plan = buildBackfillPlan(inventoryOf([eligible(ACADEMY, PERSON)]));
    await expect(applyBackfillPlan(forbidden as never, { plan, maxBatches: 0 }))
      .rejects.toMatchObject({ code: 'INVALID_MAX_BATCHES' });
  });

  it('refuses a plan with no rows array at all', async () => {
    await expect(applyBackfillPlan(forbidden as never, { plan: {} }))
      .rejects.toMatchObject({ code: 'INVALID_PLAN' });
  });
});

describe('acquireLease — a lease is never lost, whatever the client does', () => {
  it('rejects a bare callback and a pool.query-shaped object', async () => {
    await expect(acquireLease((() => {}) as never)).rejects.toMatchObject({ code: 'INVALID_SESSION_SOURCE' });
    await expect(acquireLease({ query: () => {} } as never)).rejects.toMatchObject({ code: 'INVALID_SESSION_SOURCE' });
  });

  it('rejects a source whose connect accessor throws', async () => {
    const hostile = { get connect() { throw new Error('nope'); } };
    await expect(acquireLease(hostile as never)).rejects.toMatchObject({ code: 'INVALID_SESSION_SOURCE' });
  });

  it('releases the lease when the client has no query', async () => {
    let releases = 0;
    const client = { release: () => { releases += 1; } };
    await expect(acquireLease({ connect: async () => client } as never))
      .rejects.toMatchObject({ code: 'INVALID_CLIENT' });
    expect(releases).toBe(1);
  });

  it('survives a client whose query accessor throws', async () => {
    let releases = 0;
    const client = { release: () => { releases += 1; }, get query() { throw new Error('boom'); } };
    await expect(acquireLease({ connect: async () => client } as never))
      .rejects.toMatchObject({ code: 'INVALID_CLIENT' });
    expect(releases).toBe(1);
  });

  it('does not explode when release itself is a throwing accessor', async () => {
    const client = { get release() { throw new Error('boom'); }, query: () => {} };
    await expect(acquireLease({ connect: async () => client } as never))
      .rejects.toMatchObject({ code: 'INVALID_CLIENT' });
  });

  it('reads release EXACTLY once, so a one-shot getter cannot strand a lease', async () => {
    let reads = 0;
    let releases = 0;
    const client = {
      get release() {
        reads += 1;
        if (reads > 1) throw new Error('second read explodes');
        return () => { releases += 1; };
      },
      // no query ⇒ INVALID_CLIENT, but only AFTER release was captured
    };
    await expect(acquireLease({ connect: async () => client } as never))
      .rejects.toMatchObject({ code: 'INVALID_CLIENT' });
    expect(reads).toBe(1);
    expect(releases).toBe(1);
  });

  it('releases a lease whose release function is a proxy with a throwing bind', async () => {
    // `.bind` is a property read on the callable itself; a proxy can trap it. Capturing via
    // Reflect.apply reads nothing off the function, so the lease is still releasable.
    let releases = 0;
    const proxiedRelease = new Proxy(() => { releases += 1; }, {
      get(target, prop, receiver) {
        if (prop === 'bind') throw new Error('BIND_TRAP_EXPLODED');
        return Reflect.get(target, prop, receiver);
      },
    });
    const client = { release: proxiedRelease };
    await expect(acquireLease({ connect: async () => client } as never))
      .rejects.toMatchObject({ code: 'INVALID_CLIENT' });
    expect(releases).toBe(1);
  });

  it('releases exactly once even when release is called twice', async () => {
    const release = vi.fn();
    const lease = await acquireLease({ connect: async () => ({ query: () => {}, release }) } as never);
    await lease.release();
    await lease.release();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('passes the disposal error through to the driver', async () => {
    const release = vi.fn();
    const lease = await acquireLease({ connect: async () => ({ query: () => {}, release }) } as never);
    const err = new Error('poisoned');
    await lease.release(err);
    expect(release).toHaveBeenCalledWith(err);
  });

  it('keeps `this` bound to the client, so a method-style release still works', async () => {
    const client = {
      released: false,
      query: () => {},
      release() { this.released = true; },
    };
    const lease = await acquireLease({ connect: async () => client } as never);
    await lease.release();
    expect(client.released).toBe(true);
  });
});
