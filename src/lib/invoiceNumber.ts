/**
 * Build an invoice number from prefix, year, and sequence.
 * Supports flexible formatting:
 *
 *   formatInvoiceNumber('INV', 2026, 153)           → "INV-2026-0153"
 *   formatInvoiceNumber('INV', 2026, 153, false)     → "INV-0153"
 *   formatInvoiceNumber('',    2026, 153)            → "2026-0153"
 *   formatInvoiceNumber('',    2026, 153, false)     → "0153"
 *   formatInvoiceNumber(null,  2026, 10001, false)   → "10001"
 */
export function formatInvoiceNumber(
  prefix: string | null | undefined,
  year: number,
  sequence: number,
  includeYear = true,
): string {
  const seq = String(sequence).padStart(4, '0');
  const trimmed = (prefix ?? '').trim();
  const parts: string[] = [];
  if (trimmed) parts.push(trimmed);
  if (includeYear) parts.push(String(year));
  parts.push(seq);
  return parts.join('-');
}
