// U2 — the canonical material-intent key for an identity-verification challenge.
//
// ONE authoritative place that decides how a booking's material intent is serialized, so a verified
// selection is bound to EVERY authorization-relevant field rather than a hand-picked subset (Codex
// round 3 convergence: the per-entrypoint arrays kept omitting fields — consent, notes, the whole
// intake application, invoice selections — that are written or invoiced after selection). Each
// entrypoint hands its COMPLETE material payload to buildIntentKey; the resolver stores md5 of it
// and the resume must reproduce it exactly.
//
// The scheme is VERSIONED ("v1"): a deliberate change to what counts as material bumps the version,
// which invalidates outstanding challenges by design rather than silently accepting a stale digest.
//
// Determinism: object keys are sorted recursively so key order never affects the digest. Arrays keep
// their order (a legitimate resume re-sends the identical form body, and some arrays — time windows —
// are order-meaningful); callers that build an order-insensitive set (e.g. cart slot ids) sort it
// themselves before passing it. Values are used as-is; callers normalize (lowercase email, trim)
// before building the key and do so identically on the initial submit and the resume, because it is
// the same code path.

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = canonical(src[k]);
    return out;
  }
  return v;
}

/**
 * Build the canonical intent key for a workflow from its full material field set. The result is a
 * stable string; the resolver fingerprints it (md5) and binds a consumed selection to it.
 */
export function buildIntentKey(workflow: string, fields: Record<string, unknown>): string {
  return JSON.stringify(["v1", workflow, canonical(fields)]);
}
