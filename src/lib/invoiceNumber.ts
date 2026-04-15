/**
 * Build an invoice number from prefix, year, and sequence.
 * When prefix is empty the leading dash is omitted.
 *
 * Examples:
 *   formatInvoiceNumber('INV', 2026, 153)  → "INV-2026-0153"
 *   formatInvoiceNumber('',    2026, 153)  → "2026-0153"
 */
export function formatInvoiceNumber(
  prefix: string | null | undefined,
  year: number,
  sequence: number,
): string {
  const seq = String(sequence).padStart(4, '0');
  const trimmed = (prefix ?? '').trim();
  return trimmed ? `${trimmed}-${year}-${seq}` : `${year}-${seq}`;
}
