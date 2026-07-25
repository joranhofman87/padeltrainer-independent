/**
 * Digest email rendering for the ADR-0008 worker (10c-a3).
 *
 * Turns a group's surviving members (their frozen `digest_item` snapshots + the shared destination) into the
 * single-recipient `{ to, subject, html }` tuple that store_notification_digest_request validates and freezes.
 * Pure + deterministic so it is unit-testable and produces byte-stable output for the request hash.
 *
 * The exact `digest_item` schema is finalized with the resolver (10c-b); this renders DEFENSIVELY against a
 * minimal contract — `{ title, body?, url? }` — so a partially-populated item degrades gracefully rather than
 * throwing. Everything is HTML-escaped; nothing from an item reaches the markup unescaped.
 */

export type DigestItem = {
  title?: unknown;
  body?: unknown;
  url?: unknown;
};

export type DigestRenderInput = {
  /** the sender identity (e.g. "PadelTrainer.ai <noreply@app.padeltrainer.ai>") — FROZEN into the request so a
   *  later deploy that changes the platform default cannot alter an already-stored request within its 23h
   *  idempotency window. Becomes `from`. */
  from: string;
  /** the shared recipient address (already resolved + validated live) — becomes `to`. */
  to: string;
  /** BCP-47-ish locale for the (currently minimal) copy; unknown → English. */
  locale?: string | null;
  /** member items in a deterministic order (the worker passes them created_at, id). */
  items: DigestItem[];
};

/** The complete frozen provider request — `from` included so the stored request fully determines what is sent. */
export type DigestRenderOutput = { from: string; to: string; subject: string; html: string };

/** ~90 KB store ceiling — the worker treats a render at/over this as §CH oversize. */
export const DIGEST_BYTE_BUDGET = 92160;

/**
 * Strip characters PostgreSQL jsonb cannot hold — chiefly the NUL byte (U+0000), which makes the store's
 * `frozen_request::jsonb` cast raise "unsupported Unicode escape sequence" and would strand the group. Every
 * string that reaches the rendered output passes through here first.
 */
function stripNul(s: string): string {
  // U+0000 (NUL) and lone/unpaired surrogates are the sequences PostgreSQL jsonb rejects on text→jsonb.
  // (split/join instead of String.replaceAll so this compiles under the app pre-es2021 tsc lib target.)
  return s.split("\u0000").join("").replace(/[\uD800-\uDFFF]/g, (ch, i, str) => {
    const code = ch.charCodeAt(0);
    const isHigh = code >= 0xD800 && code <= 0xDBFF;
    const paired = isHigh
      ? (() => { const n = str.charCodeAt(i + 1); return n >= 0xDC00 && n <= 0xDFFF; })()
      : (() => { const p2 = str.charCodeAt(i - 1); return p2 >= 0xD800 && p2 <= 0xDBFF; })();
    return paired ? ch : ""; // keep valid emoji surrogate pairs; drop only UNPAIRED surrogates
  })
}

function esc(v: unknown): string {
  const s = stripNul(v == null ? "" : String(v));
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;");
}

function asText(v: unknown): string {
  return stripNul(v == null ? "" : String(v));
}

/** UTF-8 byte length (matches octet_length in Postgres — the store budget is bytes, not chars). */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Replicate PostgreSQL's `jsonb::text` for a flat string-valued object — the EXACT representation
 * store_notification_digest_request validates via `octet_length(frozen_request::text)`. jsonb differs from a
 * compact `JSON.stringify` in two byte-affecting ways: (1) keys are re-ordered by (UTF-8 length, then
 * bytewise), and (2) pairs are `"key": value` joined by `", "` (spaces after `:` and `,`). String escaping
 * is identical to `JSON.stringify` (both escape `"` `\` and control chars the same, leave `/` and non-ASCII
 * raw), so per-key/per-value byte counts match — only ordering + separators change. The real-PG parity test
 * pins this against `octet_length($1::jsonb::text)`.
 */
export function pgJsonbText(obj: Record<string, string>): string {
  const enc = new TextEncoder();
  const keys = Object.keys(obj).sort((a, b) => {
    const ba = enc.encode(a), bb = enc.encode(b);
    if (ba.length !== bb.length) return ba.length - bb.length;   // shorter key first
    for (let i = 0; i < ba.length; i++) { if (ba[i] !== bb[i]) return ba[i] - bb[i]; }  // then bytewise
    return 0;
  });
  return "{" + keys.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(obj[k])}`).join(", ") + "}";
}

/** Byte length of the jsonb::text form — the authoritative size the SQL store measures. */
export function pgJsonbTextByteLength(obj: Record<string, string>): number {
  return utf8Bytes(pgJsonbText(obj));
}

/**
 * Return the URL only if it is a safe, absolute `https:` link; otherwise null (no link rendered). Blocks
 * `javascript:`/`data:`/other schemes, protocol-relative `//host`, and anything `new URL()` can't parse.
 */
export function safeHttpsUrl(raw: unknown): string | null {
  const s = raw == null ? "" : String(raw).trim();
  if (!s) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }   // relative / protocol-relative / malformed → reject
  return u.protocol === "https:" ? s : null;
}

const COPY: Record<string, { subjectOne: string; subjectMany: (n: number) => string; heading: string }> = {
  nl: {
    subjectOne: "Je PadelTrainer-update",
    subjectMany: (n) => `Je PadelTrainer-update (${n} items)`,
    heading: "Je updates",
  },
  en: {
    subjectOne: "Your PadelTrainer update",
    subjectMany: (n) => `Your PadelTrainer update (${n} items)`,
    heading: "Your updates",
  },
};

export function renderDigestEmail(input: DigestRenderInput): DigestRenderOutput {
  const lang = (input.locale ?? "en").slice(0, 2).toLowerCase();
  const copy = COPY[lang] ?? COPY.en;
  const items = input.items ?? [];
  const subject = items.length === 1 ? copy.subjectOne : copy.subjectMany(items.length);

  const rows = items.map((it) => {
    const title = asText(it.title).trim() || "—";
    const body = asText(it.body).trim();
    const url = safeHttpsUrl(it.url);   // https-only; unsafe/invalid schemes render no link
    const bodyHtml = body ? `<p style="margin:4px 0 0;color:#444">${esc(body)}</p>` : "";
    const link = url ? ` <a href="${esc(url)}">${esc(url)}</a>` : "";
    return `<li style="margin:0 0 12px"><strong>${esc(title)}</strong>${link}${bodyHtml}</li>`;
  }).join("");

  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto">` +
    `<h2 style="font-size:18px;margin:0 0 16px">${esc(copy.heading)}</h2>` +
    `<ul style="list-style:none;padding:0;margin:0">${rows}</ul>` +
    `</div>`;

  // `from` is a header value (not HTML) — jsonb-safe (NUL/lone-surrogate stripped) but not HTML-escaped.
  return { from: asText(input.from), to: input.to, subject, html };
}

/**
 * True when the frozen request would exceed the store byte budget (§CH oversize). Measured against
 * PostgreSQL's authoritative `octet_length(frozen_request::text)` (jsonb form) — NOT a compact JSON.stringify,
 * which underestimates by the jsonb separator bytes and would let a group the SQL store rejects slip through
 * (stranding it instead of splitting).
 */
export function isDigestRequestOversize(out: DigestRenderOutput): boolean {
  // measure the WHOLE frozen request (incl. `from`) — the exact object the SQL store/oversize-check byte-counts.
  return pgJsonbTextByteLength({ from: out.from, to: out.to, subject: out.subject, html: out.html }) > DIGEST_BYTE_BUDGET;
}
