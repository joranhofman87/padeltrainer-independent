/**
 * Explicit single-session adapter: presents a PGlite instance as a conforming `SessionSource`.
 *
 * PGlite IS one physical session, but the executor contract demands an EXCLUSIVE lease — nothing
 * else may use the session until release. A no-op adapter would satisfy that only for strictly
 * serialized runs, so the lease is mutex-backed: a second connect() waits for the first release()
 * rather than silently sharing the transaction.
 *
 * POISONING: `release(err)` is the executor's signal that a ROLLBACK failed, i.e. the session may
 * still hold an open or aborted transaction. A pool would discard that connection. PGlite has only
 * the one session and cannot discard it, so the adapter refuses instead: the queued waiter and every
 * later connect() reject rather than inheriting a dirty session.
 *
 * Test/rehearsal use only. Production passes a real `pg.Pool`, which satisfies the contract natively.
 */
export function pgliteSessionSource(db) {
  let tail = Promise.resolve();
  let poison = null;

  return {
    async connect() {
      if (poison) throw poison;

      let unlock;
      const held = new Promise((resolve) => { unlock = resolve; });
      const waitFor = tail;
      tail = tail.then(() => held);
      await waitFor;                       // the previous lease must end before this one begins

      if (poison) {
        unlock();                          // never strand later waiters — they will reject too
        throw poison;
      }

      let released = false;
      return {
        query: (sql, params = []) => db.query(sql, params),
        release: (err) => {
          if (released) return;            // idempotent: releasing twice must not free a later lease
          released = true;
          if (err) {
            poison = new Error(
              'PGlite session poisoned: the executor reported a failed ROLLBACK, so this session may '
              + `still hold an open or aborted transaction and cannot be safely re-leased (${err?.message ?? err}).`,
            );
          }
          unlock();
        },
      };
    },
  };
}
