/**
 * Acquire an EXCLUSIVE database session from a `SessionSource` and hand back a lease that can be
 * released exactly once.
 *
 * A `SessionSource` is any object exposing `connect() -> { query, release }` — a real `pg.Pool`
 * qualifies, because `pool.connect()` hands back one dedicated client. What is rejected is a bare
 * query callback or `pool.query` itself: neither can own a session, and `pool.query` scatters
 * statements across connections, which voids both transaction scope and any snapshot.
 *
 * WHY A SEPARATE MODULE. `runMembershipInventory` owns its session with an equivalent inline
 * implementation, shaped around its single READ ONLY transaction. The U1b applier needs the same
 * ownership discipline across SEVERAL sequential read-write transactions, so the discipline is
 * factored out here rather than copied into it. Unifying the inventory onto this helper is a
 * deliberate follow-up: it would reopen freshly reviewed code for no behavioural gain.
 *
 * The hostile-object handling below is not hypothetical decoration — each guard exists because the
 * cheapest failure mode of a lease API is to acquire a connection and then lose the ability to give
 * it back:
 *   * `query` and `release` may be throwing accessors, so every capability read is guarded;
 *   * `release` is read EXACTLY ONCE into a local — a getter could return a callable the first time
 *     and throw the second, losing a lease we could otherwise have released;
 *   * the captured callable is invoked through `Reflect.apply`, never `.bind`, because `.bind` is
 *     itself a property read on the callable and a Proxy can trap it.
 */

export class SessionLeaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SessionLeaseError';
    this.code = code;
  }
}

export function assertValidSessionSource(sessionSource) {
  let connect;
  try {
    connect = sessionSource?.connect;
  } catch {
    throw new SessionLeaseError(
      'INVALID_SESSION_SOURCE',
      'acquireLease: reading connect() off the session source threw.',
    );
  }
  if (typeof connect !== 'function') {
    throw new SessionLeaseError(
      'INVALID_SESSION_SOURCE',
      'acquireLease: pass a session SOURCE object exposing connect() — a real pg.Pool qualifies, '
      + 'because pool.connect() hands back one dedicated client. What is rejected is a bare query '
      + 'callback or pool.query itself: neither can own a session, and pool.query scatters statements '
      + 'across connections, which voids transaction scope entirely.',
    );
  }
}

/**
 * @returns {Promise<{ query: Function, release: Function }>} `release(err)` disposes a poisoned
 *          session (pg.PoolClient semantics) and is idempotent: calling it twice releases once.
 */
export async function acquireLease(sessionSource) {
  assertValidSessionSource(sessionSource);

  const client = await sessionSource.connect();

  // Read `release` EXACTLY ONCE, then never touch the callable's properties again.
  let releaseFn = null;
  try {
    const releaseCandidate = client?.release;
    if (typeof releaseCandidate === 'function') {
      releaseFn = (...args) => Reflect.apply(releaseCandidate, client, args);
    }
  } catch { releaseFn = null; }        // a throwing accessor leaves nothing callable to release

  let queryFn = null;
  try {
    const queryCandidate = client?.query;
    if (typeof queryCandidate === 'function') {
      queryFn = (...args) => Reflect.apply(queryCandidate, client, args);
    }
  } catch { queryFn = null; }

  if (releaseFn === null || queryFn === null) {
    // Give back anything we can before failing: an acquired-but-unusable client still holds a slot.
    if (releaseFn !== null) { try { await releaseFn(); } catch { /* already failing */ } }
    throw new SessionLeaseError(
      'INVALID_CLIENT',
      'acquireLease: sessionSource.connect() must resolve to { query, release }.',
    );
  }

  let released = false;
  return {
    query: queryFn,
    // Set BEFORE awaiting: a release that throws must not be retried, or a pool could hand the same
    // session to two owners.
    release: async (err) => {
      if (released) return;
      released = true;
      await releaseFn(err);
    },
  };
}
