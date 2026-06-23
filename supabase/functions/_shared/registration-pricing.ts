// Server-trusted pricing for registration-form sign-ups.
//
// SECURITY: this runs behind a PUBLIC endpoint and the result becomes a charge.
// The player's selections (which lesson types, which package, how many weeks)
// are only used to SELECT among server-defined options — every price and every
// multiplier is read from the cycle's own config. A client value is never used
// as a price, and any selection outside the cycle's allowed set is ignored or
// rejected. This closes three underpayment vectors: an un-offered (cheaper)
// lesson type, a too-short duration, and a forged package price.

export interface RegistrationPricingCycle {
  type: string;
  total_price: number | null;
  price_per_session: number | null;
  price_table: Array<{ description?: string; price?: unknown; vat_rate?: unknown }> | null;
  start_date: string | null;
  end_date: string | null;
  settings: Record<string, unknown> | null;
}

export interface RegistrationSelections {
  lessonTypes: unknown;            // client-supplied; validated against settings.lesson_types
  cyclusOptionLabel?: unknown;     // client-supplied; matched against settings.cyclus_options
  durationWeeks?: unknown;         // client-supplied; validated against settings.duration_options
}

export interface RegistrationLineItem {
  description: string;
  quantity: number;
  unit_price: number;
  vat_rate?: number;
}

export interface RegistrationCharge {
  lineItems: RegistrationLineItem[];
  subtotal: number;
  vatAmount: number;
  total: number;
  vatRate: number;
  vatBreakdown: Record<number, { subtotal: number; vat: number }>;
  /** The authoritative lesson/session count this charge was priced on — the SAME
   *  number the confirmation email must show, so the email never drifts from the
   *  invoice. number_of_sessions for a package; else the validated/floored weeks. */
  lessonCount: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Coerce caller/JSONB values to a finite number within sane bounds, else null. */
function bounded(value: unknown, max = 10000): number | null {
  const num = typeof value === "number" ? value
    : typeof value === "string" && value.trim() !== "" ? Number(value)
    : NaN;
  return Number.isFinite(num) && num >= 0 && num <= max ? num : null;
}

const MAX_INVOICE_TOTAL = 100000; // defense-in-depth cap on the computed charge

/** The date span rounded to whole weeks. This is the cycle's fallback duration when
 *  there is no package and no duration_options; it is BOTH the count shown in the email
 *  and the multiplier the invoice charges on, so the two can never disagree. (A package
 *  cycle never reaches here — its count is the explicit number_of_sessions the academy
 *  set, e.g. 10 for a 10-lesson term with a holiday week.) */
function dateSpanWeeks(startDate: string | null, endDate: string | null): number | null {
  if (!startDate || !endDate) return null;
  const w = Math.round(
    (new Date(endDate).getTime() - new Date(startDate).getTime()) / (7 * 24 * 60 * 60 * 1000),
  );
  return Number.isFinite(w) ? Math.max(1, w) : null;
}

/**
 * The authoritative lesson/session count for a registration, resolved entirely
 * from the cycle's current server config (never a client value). This is the SAME
 * number used for the invoice and the confirmation email, so they cannot drift:
 *   package selected  → its number_of_sessions (→ number_of_weeks → date span)
 *   duration_options  → the validated weeks selection (→ date span)
 *   otherwise         → the floored date span.
 */
export function resolveRegistrationLessonCount(
  cycle: RegistrationPricingCycle,
  selections: RegistrationSelections,
): number | null {
  const settings = (cycle.settings ?? {}) as Record<string, unknown>;
  const cyclusOptions = Array.isArray(settings.cyclus_options) ? (settings.cyclus_options as Array<Record<string, unknown>>) : [];
  const label = typeof selections.cyclusOptionLabel === "string" ? selections.cyclusOptionLabel : null;
  const pkg = label ? cyclusOptions.find((o) => typeof o?.label === "string" && o.label === label) ?? null : null;
  const dateWeeks = dateSpanWeeks(cycle.start_date, cycle.end_date);
  if (pkg) {
    return bounded(pkg.number_of_sessions, 520) ?? bounded(pkg.number_of_weeks, 520) ?? dateWeeks;
  }
  const durationOptions = Array.isArray(settings.duration_options)
    ? (settings.duration_options as unknown[]).map((n) => bounded(n, 520)).filter((n): n is number => n != null)
    : [];
  if (durationOptions.length > 0) {
    const requested = bounded(selections.durationWeeks, 520);
    return requested != null && durationOptions.includes(requested) ? requested : dateWeeks;
  }
  // Defense in depth: even if the chosen package never reached us (stale client / lost
  // metadata), when the cycle's packages all agree on a session count that IS the cycle's
  // real lesson count — use it instead of the raw date span, which a holiday week inflates
  // (10 lessons across an 11-week span). Display-only; the charge uses `weeks` above.
  const optionCounts = cyclusOptions
    .map((o) => bounded(o.number_of_sessions, 520))
    .filter((n): n is number => n != null);
  if (optionCounts.length > 0 && optionCounts.every((c) => c === optionCounts[0])) {
    return optionCounts[0];
  }
  return dateWeeks;
}

/**
 * Compute what a registration sign-up should be charged, entirely from the
 * cycle's server-side config. Returns null when nothing is payable (no valid
 * price / selections) so the caller skips minting rather than billing €0.
 */
export function computeRegistrationCharge(
  cycle: RegistrationPricingCycle,
  academyDefaultVatRate: number | null,
  selections: RegistrationSelections,
): RegistrationCharge | null {
  const settings = (cycle.settings ?? {}) as Record<string, unknown>;
  const pricesIncludeVat = settings.prices_include_vat !== false; // default: prices are gross
  const defaultVat = bounded(academyDefaultVatRate, 100) ?? 21;

  // Allowed lesson types, in the canonical order the price_table is indexed by.
  const standard = Array.isArray(settings.lesson_types) ? (settings.lesson_types as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const custom = Array.isArray(settings.custom_lesson_types) ? (settings.custom_lesson_types as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const orderedLT = [...standard, ...custom];
  const allowedLT = new Set(orderedLT);
  const priceTable = Array.isArray(cycle.price_table) ? cycle.price_table : [];
  const pricePerSession = bounded(cycle.price_per_session);

  // Package (cyclus_option) lookup by label — server prices only.
  const cyclusOptions = Array.isArray(settings.cyclus_options) ? (settings.cyclus_options as Array<Record<string, unknown>>) : [];
  const label = typeof selections.cyclusOptionLabel === "string" ? selections.cyclusOptionLabel : null;
  const pkg = label ? cyclusOptions.find((o) => typeof o?.label === "string" && o.label === label) ?? null : null;

  // Duration weeks: validated, never trusted as a free multiplier.
  const durationOptions = Array.isArray(settings.duration_options)
    ? (settings.duration_options as unknown[]).map((n) => bounded(n, 520)).filter((n): n is number => n != null)
    : [];
  const dateWeeks = dateSpanWeeks(cycle.start_date, cycle.end_date);
  let weeks: number | null;
  if (pkg) {
    weeks = bounded(pkg.number_of_weeks, 520) ?? dateWeeks ?? 1;
  } else if (durationOptions.length > 0) {
    const requested = bounded(selections.durationWeeks, 520);
    weeks = requested != null && durationOptions.includes(requested) ? requested : null; // reject out-of-set
  } else {
    weeks = dateWeeks; // fixed-duration cycle: client weeks are irrelevant
  }

  const lineItems: RegistrationLineItem[] = [];

  if (pkg) {
    // Package price is the server option's total_price (or price_per_session × sessions).
    let amount = bounded(pkg.total_price);
    if (amount == null) {
      const pps = bounded(pkg.price_per_session);
      const sessions = bounded(pkg.number_of_sessions, 520);
      amount = pps != null && sessions != null ? round2(pps * sessions) : null;
    }
    if (amount != null && amount > 0) {
      lineItems.push({ description: String(pkg.label).slice(0, 200), quantity: 1, unit_price: round2(amount), vat_rate: defaultVat });
    }
  } else {
    if (weeks == null) return null; // can't price per-lesson without a valid duration
    const selected = Array.isArray(selections.lessonTypes) ? selections.lessonTypes : [];
    for (const lt of selected) {
      if (typeof lt !== "string" || !allowedLT.has(lt)) continue; // SECURITY: only cycle-offered types
      const idx = orderedLT.indexOf(lt);
      const row = idx >= 0 && idx < priceTable.length ? priceTable[idx] : null;
      let perLesson = row ? bounded(row.price) : null;
      if (perLesson == null) perLesson = pricePerSession;
      if (perLesson == null || perLesson <= 0) continue;
      const rowVat = row && row.vat_rate != null ? bounded(row.vat_rate, 100) : null;
      lineItems.push({
        description: `${lt} (${weeks}×)`,
        quantity: 1,
        unit_price: round2(perLesson * weeks),
        vat_rate: rowVat ?? defaultVat,
      });
    }
  }

  if (lineItems.length === 0) return null;

  // VAT (mirror auto-create-invoice's single- vs multi-rate handling).
  const hasMultiVat = lineItems.some((i) => (i.vat_rate ?? defaultVat) !== defaultVat);
  const vatBreakdown: Record<number, { subtotal: number; vat: number }> = {};
  let subtotal: number;
  let vatAmount: number;
  let total: number;

  if (hasMultiVat) {
    let sub = 0;
    let vat = 0;
    for (const item of lineItems) {
      const lineTotal = item.quantity * item.unit_price;
      const rate = item.vat_rate ?? defaultVat;
      const lineSub = pricesIncludeVat ? lineTotal / (1 + rate / 100) : lineTotal;
      const lineVat = pricesIncludeVat ? lineTotal - lineSub : lineSub * (rate / 100);
      sub += lineSub;
      vat += lineVat;
      vatBreakdown[rate] = vatBreakdown[rate] ?? { subtotal: 0, vat: 0 };
      vatBreakdown[rate].subtotal += lineSub;
      vatBreakdown[rate].vat += lineVat;
    }
    subtotal = round2(sub);
    vatAmount = round2(vat);
    total = pricesIncludeVat
      ? round2(lineItems.reduce((s, i) => s + i.quantity * i.unit_price, 0))
      : round2(subtotal + vatAmount);
    for (const r in vatBreakdown) {
      vatBreakdown[r].subtotal = round2(vatBreakdown[r].subtotal);
      vatBreakdown[r].vat = round2(vatBreakdown[r].vat);
    }
  } else {
    const lineTotal = lineItems.reduce((s, i) => s + i.quantity * i.unit_price, 0);
    if (pricesIncludeVat) {
      total = round2(lineTotal);
      subtotal = round2(total / (1 + defaultVat / 100));
      vatAmount = round2(total - subtotal);
    } else {
      subtotal = round2(lineTotal);
      vatAmount = round2(subtotal * (defaultVat / 100));
      total = round2(subtotal + vatAmount);
    }
  }

  if (!(total > 0) || total > MAX_INVOICE_TOTAL) return null;

  return { lineItems, subtotal, vatAmount, total, vatRate: defaultVat, vatBreakdown, lessonCount: resolveRegistrationLessonCount(cycle, selections) };
}
