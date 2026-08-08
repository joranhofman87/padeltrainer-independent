// @vitest-environment node
/**
 * U1a — the inventory EXECUTOR CONTRACT.
 *
 * Session ownership is structural, so this suite tests the LIFECYCLE, not SQL: a fake client records
 * every statement and can fail at any position. That lets us assert the properties a real database
 * could not easily be made to exhibit on demand — rollback ordering, release-exactly-once, poisoned
 * connection disposal, and the fact that a bare callback or a pool cannot satisfy the API at all.
 *
 * Convergence note: an earlier design took a bare `query` callback and tried to PROVE pinning with
 * pg_backend_pid()/txid_current() probes. Three review rounds found holes in that approach, because a
 * probe and a payload read are separate calls. The interface now OWNS the session; these tests pin
 * that ownership.
 */
import { describe, it, expect } from 'vitest';
import { runMembershipInventory, InventoryExecutorError } from '../../scripts/db/u1a-membership-inventory.mjs';

const AS_OF = '2026-08-08T00:00:00Z';

type Label = 'BEGIN' | 'MODE' | 'FINGERPRINT' | 'READ' | 'COMMIT' | 'ROLLBACK';

function labelOf(sql: string): Label {
  if (/^\s*BEGIN/i.test(sql)) return 'BEGIN';
  if (/^\s*COMMIT/i.test(sql)) return 'COMMIT';
  if (/^\s*ROLLBACK/i.test(sql)) return 'ROLLBACK';
  if (/current_setting\('transaction_isolation'\)/.test(sql)) return 'MODE';
  if (/md5\(string_agg/.test(sql)) return 'FINGERPRINT';
  return 'READ';
}

function rowsFor(label: Label) {
  if (label === 'MODE') return [{ isolation: 'repeatable read', read_only: 'on' }];
  if (label === 'FINGERPRINT') return [{ n: 0, digest: '' }];
  return [];
}

interface FakeOpts {
  failAtIndex?: number;         // 0-based index into the query sequence
  failRollback?: boolean;
  rollbackRejectsWith?: unknown; // reject ROLLBACK with an arbitrary (possibly FALSY) value
  failRelease?: boolean;
  clientOverride?: unknown;     // return a deliberately malformed client
}

function makeSource(opts: FakeOpts = {}) {
  const trace: Label[] = [];
  const events: string[] = [];
  const releaseArgs: unknown[] = [];
  let connectCalls = 0;
  let releaseCalls = 0;
  const injected = new Error('INJECTED_FAILURE');

  const source = {
    // A trap: the engine must never call a `query` on the SOURCE — only on the acquired client.
    query() { throw new Error('sessionSource.query must never be used'); },
    async connect() {
      connectCalls += 1;
      if ('clientOverride' in opts) return opts.clientOverride as never;
      return {
        async query(sql: string) {
          const label = labelOf(sql);
          const index = trace.length;
          trace.push(label);
          events.push(`query:${label}`);
          if (label === 'ROLLBACK' && 'rollbackRejectsWith' in opts) {
            throw opts.rollbackRejectsWith;   // deliberately a literal: drivers can reject with one
          }
          if (label === 'ROLLBACK' && opts.failRollback) throw new Error('ROLLBACK_FAILED');
          if (opts.failAtIndex === index) throw injected;
          return { rows: rowsFor(label) };
        },
        release(err?: unknown) {
          releaseCalls += 1;
          releaseArgs.push(err);
          events.push('release');
          if (opts.failRelease) throw new Error('RELEASE_FAILED');
        },
      };
    },
  };

  return {
    source,
    trace,
    events,
    injected,
    releaseArgs,
    counts: () => ({ connectCalls, releaseCalls }),
  };
}

describe('U1a executor — the API cannot be satisfied by an unowned session', () => {
  it('rejects a bare query callback', async () => {
    const bare = async () => ({ rows: [] });
    await expect(runMembershipInventory(bare as never, { asOf: AS_OF }))
      .rejects.toMatchObject({ code: 'INVALID_SESSION_SOURCE' });
  });

  it('rejects a pool-like object that exposes only query()', async () => {
    const poolLike = { query: async () => ({ rows: [] }) };
    await expect(runMembershipInventory(poolLike as never, { asOf: AS_OF }))
      .rejects.toMatchObject({ code: 'INVALID_SESSION_SOURCE' });
  });

  it('rejects a FUNCTION decorated with a valid connect() — the object guard is load-bearing', async () => {
    // This is the shape a caller would reach for to smuggle a bare callback past a naive check.
    // Removing the `typeof !== 'object'` guard makes this test fail (mutation-checked).
    const smuggled = Object.assign(
      async () => ({ rows: [] }),
      { connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }) },
    );
    await expect(runMembershipInventory(smuggled as never, { asOf: AS_OF }))
      .rejects.toMatchObject({ code: 'INVALID_SESSION_SOURCE' });
  });

  it('rejects a client without release() and never starts a transaction', async () => {
    const noRelease = { connect: async () => ({ query: async () => ({ rows: [] }) }) };
    await expect(runMembershipInventory(noRelease as never, { asOf: AS_OF }))
      .rejects.toMatchObject({ code: 'INVALID_CLIENT' });
  });

  it('releases a malformed client that DOES expose release, before rejecting', async () => {
    let released = 0;
    const noQuery = { connect: async () => ({ release: () => { released += 1; } }) };
    await expect(runMembershipInventory(noQuery as never, { asOf: AS_OF }))
      .rejects.toMatchObject({ code: 'INVALID_CLIENT' });
    expect(released).toBe(1);
  });

  it('validates asOf BEFORE acquiring — invalid input performs zero connects', async () => {
    for (const bad of ['now', 'today', '', undefined]) {
      const f = makeSource();
      await expect(runMembershipInventory(f.source as never, { asOf: bad as never }))
        .rejects.toBeInstanceOf(InventoryExecutorError);
      expect(f.counts().connectCalls).toBe(0);
    }
  });

  it('refuses to proceed if the transaction mode did not take', async () => {
    const source = {
      connect: async () => ({
        async query(sql: string) {
          if (labelOf(sql) === 'MODE') return { rows: [{ isolation: 'read committed', read_only: 'off' }] };
          return { rows: rowsFor(labelOf(sql)) };
        },
        release: () => {},
      }),
    };
    await expect(runMembershipInventory(source as never, { asOf: AS_OF }))
      .rejects.toMatchObject({ code: 'TRANSACTION_MODE' });
  });
});

describe('U1a executor — lifecycle', () => {
  it('opens REPEATABLE READ + READ ONLY, asserts the mode, and commits once', async () => {
    const f = makeSource();
    const result = await runMembershipInventory(f.source as never, { asOf: AS_OF });

    expect(result.as_of).toBe(AS_OF);
    expect(f.trace[0]).toBe('BEGIN');
    expect(f.trace[1]).toBe('MODE');
    expect(f.trace.at(-1)).toBe('COMMIT');
    expect(f.trace.filter((t) => t === 'COMMIT')).toHaveLength(1);
    expect(f.trace).not.toContain('ROLLBACK');
    expect(f.counts()).toEqual({ connectCalls: 1, releaseCalls: 1 });
    expect(f.events.at(-1)).toBe('release');   // release comes after COMMIT
  });

  it('acquires exactly one session for the whole run', async () => {
    const f = makeSource();
    await runMembershipInventory(f.source as never, { asOf: AS_OF });
    expect(f.counts().connectCalls).toBe(1);
  });

  it('rejects — with the ORIGINAL error — and rolls back before releasing, at EVERY query position', async () => {
    // Establish the successful trace, then fail at each position in turn.
    const happy = makeSource();
    await runMembershipInventory(happy.source as never, { asOf: AS_OF });
    const positions = happy.trace.length;
    expect(positions).toBeGreaterThan(10); // BEGIN + MODE + fingerprints + reads + COMMIT

    for (let i = 0; i < positions; i += 1) {
      const f = makeSource({ failAtIndex: i });
      await expect(runMembershipInventory(f.source as never, { asOf: AS_OF }))
        .rejects.toBe(f.injected);                         // original error identity preserved

      const rollbackAt = f.events.indexOf('query:ROLLBACK');
      const releaseAt = f.events.indexOf('release');
      expect(rollbackAt, `position ${i} must roll back`).toBeGreaterThanOrEqual(0);
      expect(releaseAt, `position ${i} must release after rollback`).toBeGreaterThan(rollbackAt);
      expect(f.counts().releaseCalls, `position ${i} releases once`).toBe(1);
      // nothing runs after the rollback
      expect(f.events.slice(rollbackAt + 1).filter((e) => e.startsWith('query:'))).toEqual([]);
    }
  });

  it('discards a poisoned connection when ROLLBACK itself fails', async () => {
    const f = makeSource({ failAtIndex: 3, failRollback: true });
    await expect(runMembershipInventory(f.source as never, { asOf: AS_OF }))
      .rejects.toBe(f.injected);                            // still the ORIGINAL error
    expect(f.counts().releaseCalls).toBe(1);
    expect(f.releaseArgs[0]).toBeInstanceOf(Error);          // release(err) ⇒ pool discards it
    expect((f.releaseArgs[0] as Error).message).toBe('ROLLBACK_FAILED');
  });

  it('fails the run when release() fails on an otherwise successful run', async () => {
    const f = makeSource({ failRelease: true });
    await expect(runMembershipInventory(f.source as never, { asOf: AS_OF }))
      .rejects.toThrow('RELEASE_FAILED');
    expect(f.trace).toContain('COMMIT');
    expect(f.counts().releaseCalls).toBe(1);   // marked before awaiting ⇒ never retried
  });

  it('never issues a rollback after a confirmed commit', async () => {
    const f = makeSource({ failRelease: true });
    await expect(runMembershipInventory(f.source as never, { asOf: AS_OF })).rejects.toThrow();
    expect(f.trace).not.toContain('ROLLBACK');
  });

  it('propagates a rejected connect() exactly once, with no query and no release', async () => {
    const boom = new Error('ACQUIRE_FAILED');
    let releases = 0;
    let connects = 0;
    const source = {
      connect: async () => { connects += 1; throw boom; },
      release: () => { releases += 1; },
    };
    await expect(runMembershipInventory(source as never, { asOf: AS_OF })).rejects.toBe(boom);
    expect(connects).toBe(1);     // a rejected acquisition is never retried
    expect(releases).toBe(0);
  });

  it('disposes the connection even when ROLLBACK rejects with a FALSY value', async () => {
    // pg-pool and the PGlite adapter both dispose only on a TRUTHY release argument, so a driver
    // rejecting with undefined would otherwise silently re-lease a session of unknown state.
    for (const falsy of [undefined, null, false, 0, '']) {
      const f = makeSource({ failAtIndex: 3, rollbackRejectsWith: falsy });
      await expect(runMembershipInventory(f.source as never, { asOf: AS_OF }))
        .rejects.toBe(f.injected);
      expect(f.counts().releaseCalls).toBe(1);
      expect(f.releaseArgs[0], `falsy rollback rejection ${String(falsy)}`).toBeTruthy();
      expect(f.releaseArgs[0]).toBeInstanceOf(Error);
    }
  });

  it('releases a malformed CALLABLE client (cleanup is independent of validity)', async () => {
    let releases = 0;
    const callableClient = Object.assign(() => {}, { release: () => { releases += 1; } }); // no query
    const source = { connect: async () => callableClient };
    await expect(runMembershipInventory(source as never, { asOf: AS_OF }))
      .rejects.toMatchObject({ code: 'INVALID_CLIENT' });
    expect(releases).toBe(1);
  });

  it('releases a client whose query ACCESSOR throws, instead of leaking the lease', async () => {
    // A getter/proxy trap that throws is still an acquired lease with a callable release.
    let releases = 0;
    const client = {
      get query(): never { throw new Error('ACCESSOR_EXPLODED'); },
      release: () => { releases += 1; },
    };
    await expect(runMembershipInventory({ connect: async () => client } as never, { asOf: AS_OF }))
      .rejects.toMatchObject({ code: 'INVALID_CLIENT' });
    expect(releases).toBe(1);
  });

  it('ACCEPTS a callable client that has both query and release (documented decision)', async () => {
    // Pins the acceptance, not just the rejection: an object-only validity check would break this
    // while the malformed-callable cleanup test above kept passing.
    const trace: Label[] = [];
    let releases = 0;
    const callable = Object.assign(() => {}, {
      async query(sql: string) {
        const label = labelOf(sql);
        trace.push(label);
        return { rows: rowsFor(label) };
      },
      release: () => { releases += 1; },
    });

    const result = await runMembershipInventory(
      { connect: async () => callable } as never, { asOf: AS_OF },
    );
    expect(result.as_of).toBe(AS_OF);
    expect(trace[0]).toBe('BEGIN');
    expect(trace).toContain('COMMIT');
    expect(trace).not.toContain('ROLLBACK');
    expect(releases).toBe(1);
  });

  it('keeps the ORIGINAL error when release ALSO fails mid-run', async () => {
    const f = makeSource({ failAtIndex: 4, failRelease: true });
    await expect(runMembershipInventory(f.source as never, { asOf: AS_OF }))
      .rejects.toBe(f.injected);                 // the injected failure wins over the release failure
    expect(f.trace).toContain('ROLLBACK');
    expect(f.counts()).toEqual({ connectCalls: 1, releaseCalls: 1 });
  });
});

describe('U1a executor — the PGlite single-session adapter', () => {
  // A no-op adapter would pass every other test in this file; these pin the lease itself.
  async function makeAdapter() {
    const { pgliteSessionSource } = await import('../../scripts/db/u1a-pglite-session.mjs');
    const fakeDb = { query: async () => ({ rows: [] }) };
    return pgliteSessionSource(fakeDb as never);
  }

  const settled = async (p: Promise<unknown>) => {
    let done = false;
    void p.then(() => { done = true; }, () => { done = true; });
    await new Promise((r) => setTimeout(r, 10));
    return done;
  };

  it('blocks a second lease until the first is released', async () => {
    const sessions = await makeAdapter();
    const first = await sessions.connect();
    const second = sessions.connect();

    expect(await settled(second)).toBe(false);   // still waiting
    first.release();
    expect(await settled(second)).toBe(true);
    (await second).release();
  });

  it('a stale double-release cannot free somebody else\'s lease', async () => {
    const sessions = await makeAdapter();
    const first = await sessions.connect();
    first.release();
    const second = await sessions.connect();
    const third = sessions.connect();

    first.release();                             // stale: must NOT unblock `third`
    expect(await settled(third)).toBe(false);
    second.release();
    expect(await settled(third)).toBe(true);
    (await third).release();
  });

  it('poisons the session when release carries a rollback error', async () => {
    const sessions = await makeAdapter();
    const lease = await sessions.connect();
    lease.release(new Error('ROLLBACK_FAILED'));

    // PGlite cannot discard a connection the way a pool can, so it must refuse instead of
    // handing the next caller a session that may still hold an aborted transaction.
    await expect(sessions.connect()).rejects.toThrow(/poisoned/i);
  });

  it('rejects EVERY already-queued lease when the session gets poisoned', async () => {
    // Two waiters, not one: with a single waiter, deleting the load-bearing unlock() in the poison
    // branch still passes — it only strands the SECOND queued waiter. This is that regression.
    const sessions = await makeAdapter();
    const first = await sessions.connect();
    const queuedA = sessions.connect();
    const queuedB = sessions.connect();
    first.release(new Error('ROLLBACK_FAILED'));

    const settledWithin = async (p: Promise<unknown>) => {
      const outcome = await Promise.race([
        p.then(() => 'resolved', (e) => (/poisoned/i.test(String(e?.message ?? e)) ? 'rejected' : 'other')),
        new Promise((r) => setTimeout(() => r('timeout'), 200)),
      ]);
      return outcome;
    };
    expect(await settledWithin(queuedA)).toBe('rejected');
    expect(await settledWithin(queuedB)).toBe('rejected');   // not stranded
  });
});
