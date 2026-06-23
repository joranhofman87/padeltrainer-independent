// Single server-side source for the registration confirmation email.
//
// Both registration paths (guest → submit-guest-intake, logged-in →
// create-registration-invoice) call this with the SERVER-fetched cycle row and the
// stored intake row. Every CONFIG value (lesson count, prices, cycle name, dates,
// deadline, owner, location, currency) is resolved here from the cycle's CURRENT
// config and the SAME pricing helper the invoice uses — so the email can never drift
// from the invoice, and an academy editing the cycle is reflected immediately.
// Registrant-entered fields (phone, notes, rating…) are inherently fresh and pass
// through from the intake row.

import {
  resolveRegistrationLessonCount,
  type RegistrationPricingCycle,
  type RegistrationSelections,
} from "./registration-pricing.ts";

// Loosely typed like the other edge fns (service-role client + JSONB rows).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

export interface RegistrationEmailCycle extends RegistrationPricingCycle {
  id: string;
  owner_type: string;
  owner_id: string;
  name: string;
  currency?: string | null;
  enrollment_deadline?: string | null;
  location_id?: string | null;
}

export interface RegistrationEmailIntake {
  id: string;
  email: string;
  full_name?: string | null;
  phone?: string | null;
  birth_date?: string | null;
  rating?: number | null;
  rating_system?: string | null;
  lesson_type?: unknown;
  preferred_duration_minutes?: number | null;
  sessions_per_week?: number | null;
  location_id?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
}

const bounded = (value: unknown, max = 1_000_000): number | null => {
  const num = typeof value === "number" ? value
    : typeof value === "string" && value.trim() !== "" ? Number(value)
    : NaN;
  return Number.isFinite(num) && num >= 0 && num <= max ? num : null;
};

/**
 * Build the email `data` payload + send it via the send-email function. Returns
 * true on a 2xx from send-email. Never throws — email is a non-blocking side
 * effect of registration, so callers log failures but do not fail the request.
 */
export async function sendRegistrationConfirmationEmail(
  admin: Admin,
  cycle: RegistrationEmailCycle,
  intake: RegistrationEmailIntake,
  opts: { payUrl?: string | null; language?: string | null } = {},
): Promise<boolean> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const settings = (cycle.settings ?? {}) as Record<string, unknown>;
  const metadata = (intake.metadata ?? {}) as Record<string, unknown>;

  // --- Owner name (academy / club venue / trainer) ---
  let ownerName = "";
  if (cycle.owner_type === "academy") {
    const { data } = await admin.from("academy_profiles").select("name").eq("id", cycle.owner_id).single();
    ownerName = data?.name || "";
  } else if (cycle.owner_type === "club") {
    const { data: club } = await admin.from("club_profiles").select("location_id").eq("id", cycle.owner_id).single();
    if (club?.location_id) {
      const { data: loc } = await admin.from("locations").select("name").eq("id", club.location_id).single();
      ownerName = loc?.name || "";
    }
  } else if (cycle.owner_type === "trainer") {
    const { data: trainer } = await admin.from("trainer_profiles").select("user_id").eq("id", cycle.owner_id).single();
    if (trainer?.user_id) {
      const { data: profile } = await admin.from("profiles").select("full_name").eq("user_id", trainer.user_id).single();
      ownerName = profile?.full_name || "";
    }
  }

  // --- Location name (the registration's location, else the cycle's) ---
  let locationName = "";
  const locationId = intake.location_id || cycle.location_id;
  if (locationId) {
    const { data: loc } = await admin.from("locations").select("name").eq("id", locationId).single();
    locationName = loc?.name || "";
  }

  // --- Authoritative lesson count + price lines (same source as the invoice) ---
  const selectedLabel = typeof (metadata.selected_cyclus_option as Record<string, unknown>)?.label === "string"
    ? (metadata.selected_cyclus_option as Record<string, unknown>).label as string
    : undefined;
  const selections: RegistrationSelections = {
    lessonTypes: Array.isArray(intake.lesson_type) ? intake.lesson_type : [],
    cyclusOptionLabel: selectedLabel,
    durationWeeks: metadata.preferred_number_of_weeks,
  };
  const lessonCount = resolveRegistrationLessonCount(cycle, selections);

  const currency = cycle.currency || "EUR";
  const fmt = (v: number) => {
    try {
      return new Intl.NumberFormat("nl-NL", { style: "currency", currency }).format(v);
    } catch {
      return `€${v.toFixed(2)}`;
    }
  };

  const cyclusOptions = Array.isArray(settings.cyclus_options)
    ? (settings.cyclus_options as Array<Record<string, unknown>>) : [];
  const serverOption = selectedLabel
    ? cyclusOptions.find((o) => typeof o?.label === "string" && o.label === selectedLabel) ?? null
    : null;

  const priceLines: { label: string; perLesson: string; total: string }[] = [];
  if (serverOption) {
    // Package: one line, the package's own label + total (matches the invoice).
    const per = bounded(serverOption.price_per_session);
    const total = bounded(serverOption.total_price)
      ?? (per != null && lessonCount ? per * lessonCount : null);
    if (per != null && per > 0) {
      priceLines.push({ label: String(serverOption.label).slice(0, 200), perLesson: fmt(per), total: total != null ? fmt(total) : "" });
    }
  } else {
    // Per-lesson: one line per chosen lesson type, priced from the cycle's price_table.
    const standard = Array.isArray(settings.lesson_types) ? (settings.lesson_types as unknown[]).filter((x): x is string => typeof x === "string") : [];
    const custom = Array.isArray(settings.custom_lesson_types) ? (settings.custom_lesson_types as unknown[]).filter((x): x is string => typeof x === "string") : [];
    const orderedLT = [...standard, ...custom];
    const priceTable = Array.isArray(cycle.price_table) ? cycle.price_table : [];
    const perSession = bounded(cycle.price_per_session);
    const chosen = Array.isArray(intake.lesson_type) ? intake.lesson_type : [];
    for (const lt of chosen) {
      if (typeof lt !== "string") continue;
      const idx = orderedLT.indexOf(lt);
      const row = idx >= 0 && idx < priceTable.length ? priceTable[idx] : null;
      const per = (row ? bounded(row.price) : null) ?? perSession;
      if (per == null || per <= 0) continue;
      const total = lessonCount ? per * lessonCount : null;
      priceLines.push({ label: lt.charAt(0).toUpperCase() + lt.slice(1), perLesson: fmt(per), total: total != null ? fmt(total) : "" });
    }
  }

  const data: Record<string, unknown> = {
    playerName: intake.full_name || "",
    cycleName: cycle.name,
    ownerName,
    confirmationText: (settings.confirmation_email_text as string | undefined) || undefined,
    startDate: cycle.start_date || undefined,
    endDate: cycle.end_date || undefined,
    enrollmentDeadline: cycle.enrollment_deadline || undefined,
    locationName: locationName || undefined,
    lessonTypes: Array.isArray(intake.lesson_type) ? intake.lesson_type : [],
    preferredDurationMinutes: intake.preferred_duration_minutes || undefined,
    sessionsPerWeek: intake.sessions_per_week || undefined,
    rating: intake.rating ?? undefined,
    ratingSystem: intake.rating_system || undefined,
    notes: intake.notes || undefined,
    phone: intake.phone || undefined,
    birthDate: intake.birth_date || undefined,
    selectedPackageLabel: serverOption ? String(serverOption.label).slice(0, 200) : undefined,
    selectedPackagePrice: serverOption ? bounded(serverOption.price_per_session) ?? undefined : undefined,
    selectedDurationWeeks: lessonCount || undefined,
    priceLines: priceLines.length > 0 ? priceLines : undefined,
    currency,
    payUrl: opts.payUrl || undefined,
  };

  const res = await fetch(`${supabaseUrl}/functions/v1/send-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({
      type: "intake_registration_confirmation",
      to: intake.email,
      language: opts.language || "nl",
      data,
    }),
  });
  if (!res.ok) {
    // PII hygiene: send-email's error body can echo the recipient — log status + id only.
    console.error(`Registration confirmation email failed (status ${res.status}) for intake ${intake.id}`);
    return false;
  }
  console.log(`Registration confirmation email sent for intake ${intake.id}`);
  return true;
}
