/** Business profile completeness for auto-create-invoice. */

export type InvoiceBusinessFields = {
  business_name?: string | null;
  kvk_number?: string | null;
  iban?: string | null;
};

export function isInvoiceBusinessProfileComplete(
  profile: InvoiceBusinessFields,
): boolean {
  const name = (profile.business_name ?? "").trim();
  const kvk = (profile.kvk_number ?? "").trim();
  const iban = (profile.iban ?? "").trim();
  return Boolean(name && kvk && iban);
}

export type AutoCreateBusinessGateResult = {
  /** When true, caller should return skipped: incomplete_business_info. */
  skip: boolean;
  /** Draft created but sender details missing — PDF/send must wait. */
  incompleteBusinessProfile: boolean;
  reason?: "incomplete_business_info";
};

/**
 * Draft invoices may be created without complete business details.
 * Non-draft (sent) creation requires business_name, kvk_number, and iban.
 */
export function resolveAutoCreateBusinessGate(
  asDraft: boolean,
  profile: InvoiceBusinessFields,
): AutoCreateBusinessGateResult {
  const complete = isInvoiceBusinessProfileComplete(profile);
  if (complete) {
    return { skip: false, incompleteBusinessProfile: false };
  }
  if (asDraft) {
    return { skip: false, incompleteBusinessProfile: true };
  }
  return {
    skip: true,
    incompleteBusinessProfile: true,
    reason: "incomplete_business_info",
  };
}
