/** Pure helpers for bookkeeping forward email resolution. */

export type ForwardEmailSource = "academy" | "trainer" | "merged" | "none";

export function normalizeForwardEmails(raw: string[] | null | undefined): string[] {
  if (!raw?.length) return [];
  return raw
    .map((e) => (typeof e === "string" ? e.trim().toLowerCase() : ""))
    .filter((e) => e.includes("@"));
}

export function dedupeForwardEmails(emails: string[]): string[] {
  return [...new Set(emails)];
}

/**
 * Academy invoices: prefer academy addresses, merge trainer addresses when both exist.
 * Trainer-only invoices: trainer addresses only.
 */
export function resolveForwardRecipients(input: {
  academyProfileId: string | null;
  academyForwardEmails: string[] | null | undefined;
  trainerForwardEmails: string[] | null | undefined;
}): { emails: string[]; source: ForwardEmailSource } {
  const academy = normalizeForwardEmails(input.academyForwardEmails);
  const trainer = normalizeForwardEmails(input.trainerForwardEmails);

  if (input.academyProfileId) {
    if (academy.length > 0 && trainer.length > 0) {
      return {
        emails: dedupeForwardEmails([...academy, ...trainer]),
        source: "merged",
      };
    }
    if (academy.length > 0) {
      return { emails: academy, source: "academy" };
    }
    if (trainer.length > 0) {
      return { emails: trainer, source: "trainer" };
    }
    return { emails: [], source: "none" };
  }

  if (trainer.length > 0) {
    return { emails: trainer, source: "trainer" };
  }
  return { emails: [], source: "none" };
}
