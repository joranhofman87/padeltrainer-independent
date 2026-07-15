/**
 * Theme B / B2 — pure decisions for the invoices-bucket garbage collector.
 *
 * Contract (established in B1): an object is LIVE iff its key prefix (name minus the .html/.pdf
 * suffix) equals some invoice's render_path. Everything else is unmatched; unmatched objects are
 * only DELETE CANDIDATES once older than the grace period (owner decision: 90 days) — so a
 * backfill/matching mistake has a long window to surface in the report-only phase before anything
 * is destroyed, and an object uploaded moments ago (its invoice row committing concurrently) is
 * never eligible. NULL render_path means "no render known", never "delete my render" — deletion
 * needs a positive mismatch, and freshness always wins.
 */

export const INVOICE_GC_GRACE_DAYS = 90;
/** Per-run deletion cap: a matching bug can cost at most this many objects per day, and the
 * summary makes a capped run visible instead of silently truncating. */
export const INVOICE_GC_MAX_DELETE = 200;

export type StorageObjectRow = {
  name: string;
  updated_at?: string | null;
  created_at?: string | null;
};

export type InvoiceGcClassification = {
  /** Objects matched by some invoice's render_path — never touched. */
  live: number;
  /** Unmatched but younger than the grace period — kept this run, re-examined daily. */
  freshUnmatched: number;
  /** Unmatched and past the grace period — the delete candidates, in listing order. */
  orphans: string[];
};

/** `folder/INV-001.pdf` → `folder/INV-001`; non-render suffixes return null (never GC'd). */
export function renderPrefixOf(objectName: string): string | null {
  const m = objectName.match(/^(.+)\.(pdf|html)$/);
  return m ? m[1] : null;
}

/**
 * Classify one page of bucket objects against the live render_path set. Objects with an
 * unparseable suffix or a missing timestamp are treated as live/fresh respectively — when the GC
 * cannot positively establish "orphaned AND old", it must keep the object.
 */
export function classifyInvoiceRenderObjects(
  objects: StorageObjectRow[],
  livePrefixes: ReadonlySet<string>,
  now: Date,
  graceMs: number = INVOICE_GC_GRACE_DAYS * 24 * 60 * 60 * 1000,
): InvoiceGcClassification {
  const result: InvoiceGcClassification = { live: 0, freshUnmatched: 0, orphans: [] };
  for (const obj of objects) {
    const prefix = renderPrefixOf(obj.name);
    if (prefix === null || livePrefixes.has(prefix)) {
      result.live += 1;
      continue;
    }
    const stamp = obj.updated_at ?? obj.created_at ?? null;
    const ageMs = stamp ? now.getTime() - new Date(stamp).getTime() : 0;
    if (!stamp || !Number.isFinite(ageMs) || ageMs < graceMs) {
      result.freshUnmatched += 1;
      continue;
    }
    result.orphans.push(obj.name);
  }
  return result;
}
