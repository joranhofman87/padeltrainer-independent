import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendResendEmail } from "./resend-send.ts";
import { resolveAppBase } from "./priority-claim-invite.ts";

/**
 * The player-facing PAYMENT CONFIRMATION email, sent after a public Mollie payment
 * for a single slot OR a whole cyclus, to BOTH a guest and a registered player.
 *
 * It replaces the two divergent post-payment emails that used to run in
 * mollie-booking-paid-side-effects (a plain `booking_confirmation` for registered
 * players with NO pdf, and the raw `send-invoice-email` for guests): one friendly
 * confirmation for everyone, carrying
 *   (1) a "what you booked" table of every paid session,
 *   (2) the SAME invoice PDF the bookkeeper receives (best-effort attachment), and
 *   (3) a "sign in / create an account to see your sessions" link.
 *
 * Best-effort throughout: a missing PDF still sends the email, and the whole send is
 * non-fatal (returns an outcome; never throws). The caller gates this behind an atomic
 * paid claim, so it fires exactly once per first-transition to paid — no extra dedupe.
 */

const FROM = "PadelTrainer.ai <noreply@app.padeltrainer.ai>";
const BRAND = "#f45d25";

type LogStep = (step: string, details?: Record<string, unknown>) => void;

export type BookingConfirmationReason = "no_resend" | "no_payer" | "no_recipient_email" | "send_failed";
export type BookingConfirmationOutcome = {
  ok: boolean;
  /** Present when ok=false. */
  reason?: BookingConfirmationReason;
  recipient?: string;
  isGuest?: boolean;
  pdfAttached?: boolean;
  detail?: string;
};

/** Deno.env via globalThis so this helper stays importable in the Node/PGlite test runner. */
function env(key: string): string | undefined {
  return (globalThis as { Deno?: { env?: { get?: (k: string) => string | undefined } } }).Deno?.env?.get?.(key);
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Format a timestamptz in the platform's home timezone (mirrors the staff/player emails). */
function formatAmsterdam(iso: string, kind: "date" | "time"): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return kind === "date"
    ? new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(d)
    : new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit" }).format(d);
}

type Copy = {
  subject: string;
  heading: string;
  intro: string;
  sessionsTitle: string;
  colDate: string;
  colTime: string;
  colLocation: string;
  invoiceNote: string;
  ctaRegistered: string;
  ctaGuest: string;
  guestHint: string;
  footer: string;
};

const COPY: Record<"nl" | "en", Copy> = {
  nl: {
    subject: "Bevestiging van je boeking",
    heading: "Je boeking is bevestigd",
    intro: "Bedankt! Je betaling is ontvangen en de volgende sessie(s) staan voor je klaar:",
    sessionsTitle: "Wat je hebt geboekt",
    colDate: "Datum",
    colTime: "Tijd",
    colLocation: "Locatie",
    invoiceNote: "Je factuur zit als PDF bij deze e-mail.",
    ctaRegistered: "Bekijk mijn sessies",
    ctaGuest: "Account aanmaken en mijn sessies bekijken",
    guestHint: "Gebruik hetzelfde e-mailadres als bij je boeking, dan worden je sessies automatisch aan je account gekoppeld.",
    footer: "Tot op de baan!",
  },
  en: {
    subject: "Your booking is confirmed",
    heading: "Your booking is confirmed",
    intro: "Thanks! Your payment has been received and the following session(s) are booked for you:",
    sessionsTitle: "What you booked",
    colDate: "Date",
    colTime: "Time",
    colLocation: "Location",
    invoiceNote: "Your invoice is attached to this email as a PDF.",
    ctaRegistered: "View my sessions",
    ctaGuest: "Create an account & see my sessions",
    guestHint: "Use the same email address you booked with and your sessions will be linked to your account automatically.",
    footer: "See you on court!",
  },
};

type SessionRow = { start_time: string; end_time: string; cyclus_name: string | null; location: string };

interface BookingRow {
  id: string;
  player_id: string | null;
  guest_player_id: string | null;
  availability_slots: {
    start_time: string;
    end_time: string;
    cyclus_name: string | null;
    academy_profile_id: string | null;
    locations: { name: string | null } | null;
  } | null;
  profiles: { full_name: string | null; email: string | null; preferred_language: string | null } | null;
  guest_players: { full_name: string | null; email: string | null } | null;
}

/**
 * Resolve + send the confirmation for the just-paid `bookingIds`.
 * `invoiceId` is the invoice minted for these bookings (may be null → resolved here).
 */
export async function sendPlayerBookingConfirmation(opts: {
  supabase: SupabaseClient;
  bookingIds: string[];
  invoiceId: string | null;
  logStep: LogStep;
}): Promise<BookingConfirmationOutcome> {
  const { supabase, bookingIds, invoiceId, logStep } = opts;

  const resendApiKey = env("RESEND_API_KEY");
  if (!resendApiKey) {
    logStep("Player confirmation skipped — RESEND not configured");
    return { ok: false, reason: "no_resend" };
  }

  // All booked sessions (single slot = 1 row, cyclus = N) + the payer identity fields.
  const { data: rows } = await supabase
    .from("bookings")
    .select(`
      id, player_id, guest_player_id,
      availability_slots!inner(start_time, end_time, cyclus_name, academy_profile_id, locations(name)),
      profiles!bookings_player_id_fkey(full_name, email, preferred_language),
      guest_players(full_name, email)
    `)
    .in("id", bookingIds);
  const bookings = (rows ?? []) as unknown as BookingRow[];
  if (bookings.length === 0) return { ok: false, reason: "no_payer" };

  // Payer type from ANY row (not just [0]): a same-guest cyclus stamps guest_player_id
  // on every child row, but harden against a mixed set.
  const registered = bookings.find((b) => b.player_id && b.profiles?.email);
  const guest = bookings.find((b) => b.guest_player_id);
  const isGuest = !registered && !!guest;

  let recipientEmail: string | null = null;
  let recipientName = "";
  let language: "nl" | "en" = "nl";

  if (registered) {
    recipientEmail = registered.profiles?.email ?? null;
    recipientName = registered.profiles?.full_name ?? "";
    language = normalizeLang(registered.profiles?.preferred_language);
  } else if (guest) {
    recipientName = guest.guest_players?.full_name ?? "";
    // Single source of truth for the guest's address (honours a linked profile /
    // academy billing-email override), falling back to the booking-form address.
    try {
      const { data: idRows } = await supabase.rpc("get_invoice_recipient_identity", {
        _player_id: null,
        _guest_player_id: guest.guest_player_id,
        _academy_profile_id: guest.availability_slots?.academy_profile_id ?? null,
      });
      const identity = Array.isArray(idRows) ? idRows[0] : idRows;
      recipientEmail = (identity as { email?: string } | null)?.email ?? null;
    } catch (_e) {
      // fall through to the joined address
    }
    if (!recipientEmail) recipientEmail = guest.guest_players?.email ?? null;
  } else {
    return { ok: false, reason: "no_payer" };
  }

  if (!recipientEmail) return { ok: false, reason: "no_recipient_email" };

  // Sessions table (chronological).
  const sessions: SessionRow[] = bookings
    .map((b) => ({
      start_time: b.availability_slots?.start_time ?? "",
      end_time: b.availability_slots?.end_time ?? "",
      cyclus_name: b.availability_slots?.cyclus_name ?? null,
      location: b.availability_slots?.locations?.name ?? "",
    }))
    .filter((s) => s.start_time)
    .sort((a, b) => a.start_time.localeCompare(b.start_time));

  // Invoice PDF — the SAME artifact the bookkeeper receives. Best-effort.
  const { attachments } = await buildInvoiceAttachment(supabase, invoiceId, bookingIds, logStep);

  const appBase = resolveAppBase(env("PUBLIC_APP_URL"));
  const signInUrl = isGuest
    ? `${appBase}/app/signup/player?email=${encodeURIComponent(recipientEmail)}&name=${encodeURIComponent(recipientName)}&redirect=${encodeURIComponent("/app/player/agenda")}`
    : `${appBase}/app/auth?redirect=${encodeURIComponent("/app/player/agenda")}`;

  const html = renderHtml({ copy: COPY[language], recipientName, sessions, isGuest, signInUrl, hasPdf: attachments != null });

  const outcome = await sendResendEmail(resendApiKey, {
    from: FROM,
    to: [recipientEmail],
    subject: COPY[language].subject,
    html,
    ...(attachments ? { attachments } : {}),
  });

  if (!outcome.ok) {
    // ResendSendOutcome is a discriminated union; this helper is also type-checked under
    // the app's non-strict tsconfig (via its test), where `!ok` does not narrow it — read
    // `error` through a cast rather than relying on narrowing.
    const err = (outcome as { error?: string }).error ?? "send_failed";
    logStep("Player confirmation send failed", { error: err });
    return { ok: false, reason: "send_failed", detail: err };
  }
  logStep("Player confirmation sent", { isGuest, pdfAttached: attachments != null });
  return { ok: true, recipient: recipientEmail, isGuest, pdfAttached: attachments != null };
}

function normalizeLang(v: string | null | undefined): "nl" | "en" {
  return String(v ?? "").toLowerCase().slice(0, 2) === "en" ? "en" : "nl";
}

/**
 * Fetch (or rebuild) the invoice PDF for these bookings and return it as a Resend
 * base64 attachment. Best-effort: returns `{ attachments: undefined }` on any failure —
 * the confirmation email must never be blocked by PDF generation (mirrors send-invoice-email).
 */
async function buildInvoiceAttachment(
  supabase: SupabaseClient,
  invoiceId: string | null,
  bookingIds: string[],
  logStep: LogStep,
): Promise<{ attachments?: Array<{ filename: string; content: string }> }> {
  try {
    let id = invoiceId;
    let invoiceNumber: string | null = null;
    if (id) {
      const { data: inv } = await supabase.from("invoices").select("invoice_number").eq("id", id).maybeSingle();
      invoiceNumber = (inv as { invoice_number?: string } | null)?.invoice_number ?? null;
    } else {
      const { data: inv } = await supabase
        .from("invoices")
        .select("id, invoice_number")
        .overlaps("booking_ids", bookingIds)
        .neq("status", "cancelled")
        .limit(1)
        .maybeSingle();
      id = (inv as { id?: string } | null)?.id ?? null;
      invoiceNumber = (inv as { invoice_number?: string } | null)?.invoice_number ?? null;
    }
    if (!id) {
      logStep("Player confirmation: no invoice to attach");
      return {};
    }

    const supabaseUrl = env("SUPABASE_URL");
    const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) return {};

    const genRes = await fetch(`${supabaseUrl}/functions/v1/generate-invoice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify({ invoiceId: id }),
    });
    if (!genRes.ok) {
      logStep("Player confirmation: PDF generate failed", { status: genRes.status });
      return {};
    }
    const pdfUrl = (await genRes.json().catch(() => null))?.pdfUrl as string | undefined;
    if (!pdfUrl) return {};
    const pdfRes = await fetch(pdfUrl);
    if (!pdfRes.ok) return {};
    const bytes = new Uint8Array(await pdfRes.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return { attachments: [{ filename: `${invoiceNumber || "factuur"}.pdf`, content: btoa(binary) }] };
  } catch (e) {
    logStep("Player confirmation: PDF attach error", { error: String(e).slice(0, 200) });
    return {};
  }
}

function renderHtml(args: {
  copy: Copy;
  recipientName: string;
  sessions: SessionRow[];
  isGuest: boolean;
  signInUrl: string;
  hasPdf: boolean;
}): string {
  const { copy, recipientName, sessions, isGuest, signInUrl, hasPdf } = args;
  const greeting = recipientName ? `Hi ${esc(recipientName.split(/\s+/)[0])},` : "Hi,";
  const rowsHtml = sessions
    .map((s) => {
      const time = `${formatAmsterdam(s.start_time, "time")}–${formatAmsterdam(s.end_time, "time")}`;
      const name = s.cyclus_name ? `<div style="color:#6b7280;font-size:12px;">${esc(s.cyclus_name)}</div>` : "";
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${esc(formatAmsterdam(s.start_time, "date"))}${name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;white-space:nowrap;">${esc(time)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${esc(s.location)}</td>
      </tr>`;
    })
    .join("");

  return `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
    <h2 style="color:${BRAND};margin:0 0 8px;">${esc(copy.heading)}</h2>
    <p style="margin:0 0 4px;">${greeting}</p>
    <p style="color:#374151;line-height:1.6;margin:0 0 16px;">${esc(copy.intro)}</p>

    <h3 style="margin:20px 0 6px;font-size:15px;">${esc(copy.sessionsTitle)}</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <thead>
        <tr style="text-align:left;color:#6b7280;font-size:12px;">
          <th style="padding:6px 12px;">${esc(copy.colDate)}</th>
          <th style="padding:6px 12px;">${esc(copy.colTime)}</th>
          <th style="padding:6px 12px;">${esc(copy.colLocation)}</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>

    ${hasPdf ? `<p style="color:#374151;font-size:13px;margin:16px 0 0;">📎 ${esc(copy.invoiceNote)}</p>` : ""}

    <div style="text-align:center;margin:28px 0;">
      <a href="${signInUrl}" style="display:inline-block;background:${BRAND};color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;">
        ${esc(isGuest ? copy.ctaGuest : copy.ctaRegistered)}
      </a>
    </div>
    ${isGuest ? `<p style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 12px;color:#92400e;font-size:13px;line-height:1.5;">${esc(copy.guestHint)}</p>` : ""}

    <p style="color:#6b7280;font-size:13px;margin-top:24px;">${esc(copy.footer)}</p>
  </div>`;
}
