// Mint a standard invoice for an event registration so it can be paid through
// the existing Mollie invoice flow (create-invoice-payment → mollie-webhook →
// generate-invoice). The invoice is booking-less and academy-owned
// (trainer_id NULL) — a path the rest of the stack already handles (see
// get_academy_invoices LEFT joins, the webhook's empty-booking_ids no-op, and
// generate-invoice building purely from line_items).
//
// Shared by submit-guest-intake (guests) and the create-registration-invoice
// edge function (logged-in players) so both surfaces mint identically.

import { isInvoiceBusinessProfileComplete } from "./invoice-business.ts";
import { computeRegistrationCharge, type RegistrationSelections } from "./registration-pricing.ts";

// The Supabase service-role client; typed loosely like the other edge fns.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

export type PaymentMethodSetting = "online" | "cash" | "both" | null | undefined;
export type EffectivePaymentMethod = "online" | "cash";

export interface RegistrationInvoiceCycle {
  id: string;
  owner_type: string;
  owner_id: string;
  name: string;
  type: string;
  total_price: number | null;
  price_per_session: number | null;
  // Registration-type pricing inputs (computed server-side, never trusted from client).
  price_table?: Array<{ description?: string; price?: unknown; vat_rate?: unknown }> | null;
  start_date?: string | null;
  end_date?: string | null;
  currency?: string | null;
  settings: Record<string, unknown> | null;
}

export interface RegistrationInvoiceRecipient {
  player_id: string | null;
  guest_player_id: string | null;
  player_name: string;
}

export type MintResult =
  | {
      ok: true;
      invoiceId: string;
      invoiceNumber: string;
      publicToken: string;
      slug: string | null;
      status: string;
      total: number;
      method: EffectivePaymentMethod;
    }
  | {
      ok: false;
      reason:
        | "not_paid_event"
        | "not_academy"
        | "no_price_set"
        | "business_profile_incomplete"
        | "error";
      message?: string;
    };

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Resolve the effective payment method for a cycle + the player's choice.
 * 'online'/'cash' are fixed; 'both' = "player chooses" (default online). Returns
 * null when the cycle isn't configured for payment at all.
 */
export function resolveEffectivePaymentMethod(
  paymentMethods: PaymentMethodSetting,
  chosen?: string | null,
): EffectivePaymentMethod | null {
  if (paymentMethods === "online") return "online";
  if (paymentMethods === "cash") return "cash";
  if (paymentMethods === "both") return chosen === "cash" ? "cash" : "online";
  return null;
}

/**
 * The gross amount a player owes for an event registration. Events are a flat
 * fee, so use total_price ONLY — never fall back to price_per_session (that is
 * per-lesson pricing for cyclus/registration cycles and would mis-charge). The
 * form shows total_price for events, so the invoice matches what the player saw.
 */
export function resolveEventPrice(cycle: RegistrationInvoiceCycle): number | null {
  const price = cycle.type === "event" ? cycle.total_price : (cycle.total_price ?? cycle.price_per_session);
  if (price == null || !(Number(price) > 0)) return null;
  return Number(price);
}

/**
 * Mint a 'sent' (payable) invoice for an academy event registration.
 * v1: academy-owned events only. The returned publicToken + slug let the caller
 * build the existing public pay URL: /<lang>/academies/<slug>/pay/<token>.
 */
export async function mintEventRegistrationInvoice(
  admin: Admin,
  cycle: RegistrationInvoiceCycle,
  recipient: RegistrationInvoiceRecipient,
  method: EffectivePaymentMethod,
  selections?: RegistrationSelections,
): Promise<MintResult> {
  if (cycle.type !== "event" && cycle.type !== "registration") return { ok: false, reason: "not_paid_event" };
  // v1: events/registrations are academy-owned; trainer/club are a follow-on.
  if (cycle.owner_type !== "academy") return { ok: false, reason: "not_academy" };

  // Academy invoice profile: business details (legal gate) + numbering + VAT + slug.
  const { data: academy, error: academyErr } = await admin
    .from("academy_profiles")
    .select(
      "business_name, business_address, kvk_number, btw_number, iban, default_vat_rate, payment_terms_days, invoice_prefix, invoice_include_year, slug",
    )
    .eq("id", cycle.owner_id)
    .single();
  if (academyErr || !academy) {
    return { ok: false, reason: "error", message: academyErr?.message ?? "academy profile not found" };
  }
  if (!isInvoiceBusinessProfileComplete(academy)) {
    return { ok: false, reason: "business_profile_incomplete" };
  }

  // The charge, computed entirely from server-trusted config. Event = flat
  // total_price (VAT-inclusive); registration = per-selection package validated
  // + priced server-side (registration-pricing.ts).
  const defaultVat = academy.default_vat_rate ?? 21;
  let charge: {
    lineItems: Array<{ description: string; quantity: number; unit_price: number; vat_rate?: number }>;
    subtotal: number;
    vatAmount: number;
    total: number;
    vatRate: number;
    vatBreakdown: Record<number, { subtotal: number; vat: number }>;
  };
  if (cycle.type === "event") {
    const gross = resolveEventPrice(cycle);
    if (gross == null) return { ok: false, reason: "no_price_set" };
    const total = round2(gross);
    const subtotal = round2(total / (1 + defaultVat / 100));
    charge = {
      lineItems: [{ description: cycle.name, quantity: 1, unit_price: total }],
      subtotal,
      vatAmount: round2(total - subtotal),
      total,
      vatRate: defaultVat,
      vatBreakdown: {},
    };
  } else {
    const computed = computeRegistrationCharge(cycle, defaultVat, selections ?? { lessonTypes: [] });
    if (!computed) return { ok: false, reason: "no_price_set" };
    charge = computed;
  }

  // Invoice number — same atomic scheme as auto-create-invoice (scan the
  // academy's last number for p_min, then the per-profile counter RPC).
  const prefix = (academy.invoice_prefix ?? "").trim();
  const year = new Date().getFullYear();
  const includeYear = academy.invoice_include_year ?? true;
  const likePattern = prefix
    ? includeYear
      ? `${prefix}-${year}-%`
      : `${prefix}-%`
    : includeYear
      ? `${year}-%`
      : "%";

  const buildInvoiceNumber = (sequence: number): string => {
    const seq = String(sequence).padStart(4, "0");
    const parts: string[] = [];
    if (prefix) parts.push(prefix);
    if (includeYear) parts.push(String(year));
    parts.push(seq);
    return parts.join("-");
  };

  const allocateInvoiceNumber = async (): Promise<string> => {
    const { data: last } = await admin
      .from("invoices")
      .select("invoice_number")
      .eq("academy_profile_id", cycle.owner_id)
      .like("invoice_number", likePattern)
      .order("invoice_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    let minSequence = 1;
    if (last?.invoice_number) {
      const segs = String(last.invoice_number).split("-");
      const lastSeq = parseInt(segs[segs.length - 1] || "0", 10);
      if (Number.isFinite(lastSeq)) minSequence = lastSeq + 1;
    }
    const { data: allocated, error: allocErr } = await admin.rpc("next_invoice_sequence", {
      p_profile_type: "academy",
      p_profile_id: cycle.owner_id,
      p_min: minSequence,
    });
    if (allocErr || typeof allocated !== "number") {
      throw new Error(`Failed to allocate invoice number: ${allocErr?.message ?? "no sequence"}`);
    }
    return buildInvoiceNumber(allocated);
  };

  const invoiceDate = new Date();
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + (academy.payment_terms_days || 14));

  const slug = academy.slug ?? null;
  const ok = (inv: { id: string; public_token: string; invoice_number?: string; status?: string }): MintResult => ({
    ok: true,
    invoiceId: inv.id,
    invoiceNumber: inv.invoice_number ?? "",
    publicToken: inv.public_token,
    slug,
    status: inv.status ?? "sent",
    total: charge.total,
    method,
  });

  // Idempotency: a registrant may have at most one LIVE invoice per event
  // (enforced by uniq_live_event_invoice_per_registrant). Return the existing
  // one instead of minting a second on a resubmit / retry.
  const recipientCol = recipient.player_id ? "player_id" : "guest_player_id";
  const recipientVal = recipient.player_id ?? recipient.guest_player_id;
  const findExistingLive = async () => {
    if (!recipientVal) return null;
    const { data } = await admin
      .from("invoices")
      .select("id, public_token, invoice_number, status")
      .eq("cycle_id", cycle.id)
      .eq(recipientCol, recipientVal)
      .not("status", "in", "(paid,cancelled)")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return data ?? null;
  };

  const preExisting = await findExistingLive();
  if (preExisting) return ok(preExisting);

  // Insert with collision-retry: re-allocate on a number clash; on the
  // dedup-index clash (a concurrent mint won) return that winner's invoice.
  let invoiceNumber = await allocateInvoiceNumber();
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await admin
      .from("invoices")
      .insert({
        academy_profile_id: cycle.owner_id,
        trainer_id: null,
        cycle_id: cycle.id,
        invoice_number: invoiceNumber,
        invoice_date: invoiceDate.toISOString().split("T")[0],
        due_date: dueDate.toISOString().split("T")[0],
        player_id: recipient.player_id,
        guest_player_id: recipient.guest_player_id,
        player_name: recipient.player_name || "Onbekend",
        line_items: charge.lineItems,
        subtotal: charge.subtotal,
        vat_rate: charge.vatRate,
        vat_amount: charge.vatAmount,
        total: charge.total,
        ...(Object.keys(charge.vatBreakdown).length > 0 ? { vat_breakdown: charge.vatBreakdown } : {}),
        prices_include_vat: (cycle.settings?.prices_include_vat as boolean | undefined) !== false,
        status: "sent",
        booking_ids: [],
      })
      .select("id, public_token, invoice_number, status")
      .single();
    if (!res.error) {
      // Audit trail for money movement (no PII beyond ids).
      console.log("registration invoice minted", JSON.stringify({
        invoiceId: res.data.id, academyId: cycle.owner_id, cycleId: cycle.id, type: cycle.type,
        total: charge.total, vatRate: charge.vatRate, lines: charge.lineItems.length, method,
      }));
      return ok(res.data);
    }
    const errText = `${res.error.message ?? ""} ${res.error.details ?? ""}`;
    if (res.error.code === "23505" && /uniq_live_event_invoice_per_registrant/.test(errText)) {
      const winner = await findExistingLive();
      if (winner) return ok(winner);
      return { ok: false, reason: "error", message: "dedup clash but no existing invoice found" };
    }
    const isNumberCollision =
      res.error.code === "23505" && /unique_invoice_number_per_(trainer|academy)/.test(errText);
    if (!isNumberCollision) {
      return { ok: false, reason: "error", message: res.error.message };
    }
    invoiceNumber = await allocateInvoiceNumber();
  }

  return { ok: false, reason: "error", message: "invoice insert failed after retries" };
}

/** The public pay-page path for a minted invoice (lands on PublicInvoicePay → Mollie). */
export function buildPayUrl(slug: string | null, publicToken: string, lang = "nl"): string {
  // The app only serves nl/en; clamp anything else (e.g. 'en-US') to a real route.
  const safeLang = lang === "en" ? "en" : "nl";
  return slug
    ? `/${safeLang}/academies/${slug}/pay/${publicToken}`
    : `/${safeLang}/pay/${publicToken}`;
}
