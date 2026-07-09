// Bound an awaited downstream call (an edge-function invoke, a slow RPC) so a HANG can't run out the
// edge isolate's platform wall-clock. When the platform kills a hung isolate mid-await, it skips ALL
// cleanup — for the strict rebook pay path that means a seat HOLD is left booked with no invoice and no
// payment (the "Mollie won't load, then my spot is silently reserved" class of failure). Racing the
// call against an explicit deadline converts that silent kill into a deterministic rejection the caller
// can catch and handle (release the seats + alert) while the isolate is still alive.

/**
 * Resolve with `p`'s value if it settles within `ms`; otherwise REJECT with
 * `Error("timeout:<label>")`. `p`'s own rejection is propagated unchanged. The pending
 * timer is cleared as soon as `p` settles so it can never keep the isolate alive on the
 * happy path.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout:${label}`)), ms);
  });
  const cleared = p.then(
    (v) => {
      if (timer !== undefined) clearTimeout(timer);
      return v;
    },
    (e) => {
      if (timer !== undefined) clearTimeout(timer);
      throw e;
    },
  );
  return Promise.race([cleared, timeout]);
}
