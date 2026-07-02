/**
 * Sanitize a user-supplied email subject line before it reaches the mail transport.
 *
 * Subjects are a single header line, so any CR/LF must be stripped — a newline in a
 * subject is the classic email header-injection vector (a crafted value could inject
 * extra headers / a fake body). We also collapse internal whitespace, trim, and cap
 * the length. Returns "" for empty/whitespace input, so callers can `|| default`.
 */
export function sanitizeEmailSubject(raw: unknown, maxLength = 150): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\r\n]+/g, " ") // no header injection: newlines become a space
    .replace(/\s+/g, " ") // collapse runs of whitespace
    .trim()
    .slice(0, maxLength);
}
