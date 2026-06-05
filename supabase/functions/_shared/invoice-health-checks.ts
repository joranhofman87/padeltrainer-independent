export type InvoiceAnomaly = {
  check: string;
  count: number;
  ids: string[];
  numbers: string[];
};

const SAMPLE_LIMIT = 5;

/** True when every linked booking is paid but the invoice itself is not paid. */
export function isAllBookingsPaidMismatch(
  bookingIds: string[] | null | undefined,
  bookings: { id: string; payment_status: string }[] | null | undefined,
): boolean {
  if (!bookingIds?.length) return false;
  if (!bookings?.length || bookings.length !== bookingIds.length) return false;
  return bookings.every((b) => b.payment_status === "paid");
}

export function pushAnomaly(
  anomalies: InvoiceAnomaly[],
  check: string,
  rows: { id: string; invoice_number?: string | null }[],
): void {
  if (!rows.length) return;
  anomalies.push({
    check,
    count: rows.length,
    ids: rows.map((r) => r.id),
    numbers: rows
      .map((r) => r.invoice_number)
      .filter((n): n is string => typeof n === "string" && n.length > 0),
  });
}

export function formatAnomalySlackLine(anomaly: InvoiceAnomaly): string {
  const idSample = anomaly.ids.slice(0, SAMPLE_LIMIT).join(", ");
  const numberSample = anomaly.numbers.slice(0, SAMPLE_LIMIT).join(", ");
  const suffix =
    anomaly.count > SAMPLE_LIMIT ? "..." : "";
  const parts = [`${anomaly.check}: ${anomaly.count}`];
  if (idSample) parts.push(`ids=${idSample}${suffix}`);
  if (numberSample) parts.push(`numbers=${numberSample}${suffix}`);
  return parts.join(" | ");
}

export function formatAnomalySlackDetails(anomalies: InvoiceAnomaly[]): string {
  return anomalies.map(formatAnomalySlackLine).join("\n");
}
