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
  /** the shared recipient address (already resolved + validated live) — becomes `to`. */
  to: string;
  /** BCP-47-ish locale for the (currently minimal) copy; unknown → English. */
  locale?: string | null;
  /** member items in a deterministic order (the worker passes them created_at, id). */
  items: DigestItem[];
};

export type DigestRenderOutput = { to: string; subject: string; html: string };

/** ~90 KB store ceiling — the worker treats a render at/over this as §CH oversize. */
export const DIGEST_BYTE_BUDGET = 92160;

function esc(v: unknown): string {
  const s = v == null ? "" : String(v);
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;");
}

function asText(v: unknown): string {
  return v == null ? "" : String(v);
}

/** UTF-8 byte length (matches octet_length in Postgres — the store budget is bytes, not chars). */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
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
    const url = asText(it.url).trim();
    const bodyHtml = body ? `<p style="margin:4px 0 0;color:#444">${esc(body)}</p>` : "";
    const link = url ? ` <a href="${esc(url)}">${esc(url)}</a>` : "";
    return `<li style="margin:0 0 12px"><strong>${esc(title)}</strong>${link}${bodyHtml}</li>`;
  }).join("");

  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto">` +
    `<h2 style="font-size:18px;margin:0 0 16px">${esc(copy.heading)}</h2>` +
    `<ul style="list-style:none;padding:0;margin:0">${rows}</ul>` +
    `</div>`;

  return { to: input.to, subject, html };
}

/** True when the frozen request JSON `{to,subject,html}` would exceed the store byte budget (§CH oversize). */
export function isDigestRequestOversize(out: DigestRenderOutput): boolean {
  return utf8Bytes(JSON.stringify({ to: out.to, subject: out.subject, html: out.html })) > DIGEST_BYTE_BUDGET;
}
