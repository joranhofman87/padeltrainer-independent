/**
 * Explicit single-session adapter: presents a PGlite instance as a conforming `SessionSource`.
 *
 * PGlite IS one physical session, but the executor contract demands an EXCLUSIVE lease — nothing
 * else may use the session until release. A no-op adapter would satisfy that only for strictly
 * serialized runs, so the lease is mutex-backed: a second connect() waits for the first release()
 * rather than silently sharing the transaction.
 *
 * Test/rehearsal use only. Production passes a real `pg.Pool`, which satisfies the contract natively.
 */
export function pgliteSessionSource(db) {
  let tail = Promise.resolve();

  return {
    async connect() {
      let unlock;
      const held = new Promise((resolve) => { unlock = resolve; });
      const waitFor = tail;
      tail = tail.then(() => held);
      await waitFor;                       // the previous lease must end before this one begins

      let released = false;
      return {
        query: (sql, params = []) => db.query(sql, params),
        release: () => {
          if (released) return;            // idempotent: releasing twice must not free a later lease
          released = true;
          unlock();
        },
      };
    },
  };
}
