import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveAppBase } from "./priority-claim-invite.ts";

/**
 * The player-facing PAYMENT CONFIRMATION email, sent after a public Mollie payment
 * for a single slot OR a whole cyclus, to BOTH a guest and a registered player.
 *
 * Notification Foundation v2 (PR 6a): this no longer sends via Resend directly — it
 * COMPOSES the email (subject + html + the invoice-PDF attachment) and hands it to the
 * resolver (enqueue_notification) as a `booking_confirmed_player` intent. The resolver
 * owns destination + consent + idempotency; the email worker (cron) does the actual send.
 *   * registered player → the resolver's persons.email ACCOUNT fallback (keyed on user_id),
 *   * guest → a TENANT-SCOPED notification_contacts row upserted here (ensure_guest_email_contact),
 *     because a guest has no account email and MUST NOT reuse a shared address cross-tenant.
 * The PDF rides in the outbox payload (built once here, deterministic on worker retries).
 *
 * Idempotent: the resolver keys on `booking_confirmed_player:<subject>:<recipient>` where the
 * subject derives from the invoice/payment/booking refs — so the same paid claim, re-run by a
 * duplicate webhook/verify delivery, is a no-op (no duplicate outbox row, no double-send).
 * Best-effort + non-fatal throughout: a missing PDF still enqueues; a guest with no collected
 * email produces a VISIBLE required-but-skipped outbox row (skip_reason 'no_email_contact'),
 * never a silent drop. The caller gates this behind the atomic paid claim (E-15).
 */

const BRAND = "#f45d25";

type LogStep = (step: string, details?: Record<string, unknown>) => void;

export type BookingConfirmationReason = "no_payer" | "skipped" | "enqueue_failed";
export type BookingConfirmationOutcome = {
  /** true = an email row is enqueued 'pending' (or was already, idempotently). */
  ok: boolean;
  /** Present when ok=false. */
  reason?: BookingConfirmationReason;
  isGuest?: boolean;
  pdfAttached?: boolean;
  /** The outbox row this call created (absent on an idempotent no-op or hard failure). */
  outboxId?: string;
  /** 'pending' | 'skipped' | 'already_enqueued' */
  status?: string;
  /** e.g. 'no_email_contact' when a required confirmation could not be delivered. */
  skipReason?: string;
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
type Attachment = { filename: string; content: string };

interface BookingRow {
  id: string;
  player_id: string | null;
  guest_player_id: string | null;
  availability_slots: {
    start_time: string;
    end_time: string;
    cyclus_name: string | null;
    trainer_id: string | null;
    academy_profile_id: string | null;
    locations: { name: string | null } | null;
  } | null;
  profiles: { user_id: string | null; full_name: string | null; email: string | null; preferred_language: string | null } | null;
  guest_players: { full_name: string | null; email: string | null } | null;
}

/**
 * Resolve + ENQUEUE the confirmation for the just-paid `bookingIds`.
 * `invoiceId` is the invoice minted for these bookings (may be null → resolved here for the PDF).
 * `molliePaymentId` threads the payment id so the resolver derives a stable idempotency subject.
 */
export async function sendPlayerBookingConfirmation(opts: {
  supabase: SupabaseClient;
  bookingIds: string[];
  invoiceId: string | null;
  molliePaymentId?: string | null;
  logStep: LogStep;
}): Promise<BookingConfirmationOutcome> {
  const { supabase, bookingIds, invoiceId, molliePaymentId, logStep } = opts;

  // All booked sessions (single slot = 1 row, cyclus = N) + the payer identity fields.
  // RECIPIENT-DISCOVERY read: inspect the error. supabase-js resolves on failure, so this
  // used to collapse into `rows ?? []` → `no_payer` — reporting "this booking has no payer"
  // for what was actually a broken query. The alert then named the wrong cause, which is
  // worse than no alert: it sends the next investigation looking at the booking's data.
  const { data: rows, error: rowsErr } = await supabase
    .from("bookings")
    .select(`
      id, player_id, guest_player_id,
      availability_slots!inner(start_time, end_time, cyclus_name, trainer_id, academy_profile_id, locations(name)),
      profiles!bookings_player_id_fkey(user_id, full_name, email, preferred_language),
      guest_players(full_name, email)
    `)
    .in("id", bookingIds);
  if (rowsErr) {
    logStep("Player confirmation: booking read FAILED", { error: rowsErr.message });
    return { ok: false, reason: "enqueue_failed", detail: rowsErr.message.slice(0, 200) };
  }
  const bookings = (rows ?? []) as unknown as BookingRow[];
  if (bookings.length === 0) return { ok: false, reason: "no_payer" };

  // Every requested id must have come back. A missing one means the set describes bookings
  // that are not there (or are RLS-filtered) — proceeding would confirm a partial set.
  const wanted = new Set(bookingIds);
  const foundIds = new Set(bookings.map((b) => b.id));
  if ([...wanted].some((id) => !foundIds.has(id))) {
    logStep("Player confirmation: booking set incomplete", { wanted: wanted.size, found: foundIds.size });
    return { ok: false, reason: "enqueue_failed", detail: "booking set incomplete (some ids not returned)" };
  }

  // GUEST-FIRST canonical recipient (FAM-02): a booking carrying a guest_player_id belongs to
  // the GUEST regardless of any player_id, so a DUAL-KEY booking is NEVER emailed to the
  // registered profile. Finding a registered row first (the old bug) mailed the profile
  // account for a guest's booking. One confirmation is for ONE payer, so a set that resolves
  // to several distinct recipients is refused rather than sent to whichever appears first.
  const canonicalKey = (b: BookingRow): string | null =>
    b.guest_player_id
      ? `guest:${b.guest_player_id}`
      : (b.player_id && b.profiles?.user_id ? `user:${b.profiles.user_id}` : null);
  const keys = [...new Set(bookings.map(canonicalKey))];
  if (keys.includes(null)) return { ok: false, reason: "no_payer" };   // a session with no recipient
  if (keys.length !== 1) {
    logStep("Player confirmation: set covers multiple recipients", { recipients: keys.length });
    return { ok: false, reason: "enqueue_failed", detail: "confirmation set covers multiple recipients" };
  }
  const isGuestRecipient = keys[0]!.startsWith("guest:");
  // XOR by construction: exactly one of these is defined, so the resolver never sees both.
  const registered = isGuestRecipient ? undefined : bookings.find((b) => b.player_id && b.profiles?.user_id);
  const guest = isGuestRecipient ? bookings.find((b) => b.guest_player_id) : undefined;

  // Tenant context from the booked slot (all rows of one payment share it; take any slot).
  const slot = bookings.find((b) => b.availability_slots)?.availability_slots ?? null;
  const academyProfileId = slot?.academy_profile_id ?? null;
  const trainerId = slot?.trainer_id ?? null;

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

  // Invoice PDF — the SAME artifact the bookkeeper receives. Best-effort; rides in the
  // outbox payload so the worker's send (and any retry) is self-contained + deterministic.
  const { attachments } = await buildInvoiceAttachment(supabase, invoiceId, bookingIds, logStep);
  const pdfAttached = attachments != null;
  const appBase = resolveAppBase(env("PUBLIC_APP_URL"));

  if (registered) {
    const userId = registered.profiles?.user_id as string;
    const language = normalizeLang(registered.profiles?.preferred_language);
    const recipientName = registered.profiles?.full_name ?? "";
    const signInUrl = `${appBase}/app/auth?redirect=${encodeURIComponent("/app/player/agenda")}`;
    const html = renderHtml({ copy: COPY[language], recipientName, sessions, isGuest: false, signInUrl, hasPdf: pdfAttached });
    return await enqueueConfirmation(supabase, {
      recipient: { p_recipient_user_id: userId },
      academyProfileId, trainerId, bookingIds, invoiceId, molliePaymentId,
      subject: COPY[language].subject, html, attachments, isGuest: false, pdfAttached, logStep,
    });
  }

  if (!guest) return { ok: false, reason: "no_payer" };
  const guestPlayerId = guest.guest_player_id as string;
  const recipientName = guest.guest_players?.full_name ?? "";
  const language: "nl" | "en" = "nl"; // guests have no profile language preference

  // AUTHORITATIVE guest address (a linked profile / academy billing-email override), falling
  // back to the booking-form address ONLY on a successful no-email answer.
  //
  // This is a RECIPIENT-DISCOVERY read, so it FAILS LOUD (PR 10a doctrine, and the exact
  // pattern already removed from enqueue_booking_notification): a returned { error } OR a
  // thrown exception aborts the lane. Swallowing it would let a lookup failure promote the raw
  // guest_players.email — potentially stale — into the authoritative tenant contact.
  let recipientEmail: string | null = null;
  try {
    const { data: idRows, error: idErr } = await supabase.rpc("get_invoice_recipient_identity", {
      _player_id: null,
      _guest_player_id: guestPlayerId,
      _academy_profile_id: academyProfileId,
    });
    if (idErr) {
      logStep("Guest identity lookup returned an error — enqueue aborted", { error: idErr.message });
      return { ok: false, reason: "enqueue_failed", isGuest: true, pdfAttached, detail: idErr.message.slice(0, 200) };
    }
    const identity = Array.isArray(idRows) ? idRows[0] : idRows;
    recipientEmail = (identity as { email?: string } | null)?.email ?? null;
  } catch (e) {
    logStep("Guest identity lookup threw — enqueue aborted", { error: String(e) });
    return { ok: false, reason: "enqueue_failed", isGuest: true, pdfAttached, detail: String(e).slice(0, 200) };
  }
  // The DESIGNED fallback: a successful identity answer that simply carries no email.
  if (!recipientEmail) recipientEmail = guest.guest_players?.email ?? null;

  // ALWAYS reconcile the guest's contact — INCLUDING when recipientEmail is null. The SQL
  // helper owns the whole lifecycle: a present address upserts (un-revokes / refreshes
  // provenance); a NULL address REVOKES any stale contact so the resolver cannot still deliver
  // to it. Gating this on a present email was the hole — a guest whose email was removed kept a
  // live contact and kept receiving mail. After a successful reconcile the enqueue proceeds, so
  // a no-address guest resolves to the intended VISIBLE no_email_contact skip. A reconcile
  // FAILURE (returned or thrown) aborts loudly rather than enqueueing a misleading skip.
  let contactErr: string | null = null;
  try {
    const { error } = await supabase.rpc("ensure_guest_email_contact", {
      p_guest_player_id: guestPlayerId,
      p_email: recipientEmail,   // may be null → the helper revokes the stale contact
      p_academy_profile_id: academyProfileId,
      p_trainer_id: trainerId,
    });
    if (error) contactErr = error.message;
  } catch (e) {
    contactErr = String(e);
  }
  if (contactErr) {
    const detail = contactErr.slice(0, 200);
    logStep("Guest contact reconcile failed — enqueue aborted", { error: detail });
    return { ok: false, reason: "enqueue_failed", isGuest: true, pdfAttached, detail };
  }

  const signInUrl = `${appBase}/app/signup/player?email=${encodeURIComponent(recipientEmail ?? "")}&name=${encodeURIComponent(recipientName)}&redirect=${encodeURIComponent("/app/player/agenda")}`;
  const html = renderHtml({ copy: COPY[language], recipientName, sessions, isGuest: true, signInUrl, hasPdf: pdfAttached });
  return await enqueueConfirmation(supabase, {
    recipient: { p_recipient_guest_player_id: guestPlayerId },
    academyProfileId, trainerId, bookingIds, invoiceId, molliePaymentId,
    subject: COPY[language].subject, html, attachments, isGuest: true, pdfAttached, logStep,
  });
}

type EnqueueRow = { outbox_id: string; channel: string; status: string; skip_reason: string | null };

/** Call the resolver + interpret its return (pending / skipped / idempotent no-op). */
async function enqueueConfirmation(
  supabase: SupabaseClient,
  args: {
    recipient: { p_recipient_user_id?: string; p_recipient_guest_player_id?: string };
    academyProfileId: string | null;
    trainerId: string | null;
    bookingIds: string[];
    invoiceId: string | null;
    molliePaymentId?: string | null;
    subject: string;
    html: string;
    attachments?: Attachment[];
    isGuest: boolean;
    pdfAttached: boolean;
    logStep: LogStep;
  },
): Promise<BookingConfirmationOutcome> {
  const { recipient, academyProfileId, trainerId, bookingIds, invoiceId, molliePaymentId, subject, html, attachments, isGuest, pdfAttached, logStep } = args;

  const payload: { subject: string; html: string; attachments?: Attachment[] } = { subject, html };
  if (attachments && attachments.length > 0) payload.attachments = attachments;

  const { data, error } = await supabase.rpc("enqueue_notification", {
    p_event_key: "booking_confirmed_player",
    p_recipient_person_id: null,
    p_recipient_user_id: recipient.p_recipient_user_id ?? null,
    p_recipient_guest_player_id: recipient.p_recipient_guest_player_id ?? null,
    p_tenant_academy_profile_id: academyProfileId,
    p_tenant_trainer_id: trainerId,
    p_related_booking_ids: bookingIds,
    p_related_invoice_id: invoiceId,
    p_related_payment_id: molliePaymentId ?? null,
    p_payload: payload,
  });

  if (error) {
    logStep("Player confirmation enqueue failed", { error: error.message, isGuest });
    return { ok: false, reason: "enqueue_failed", isGuest, pdfAttached, detail: error.message };
  }

  const emitted = (data ?? []) as EnqueueRow[];
  const emailRow = emitted.find((r) => r.channel === "email");

  // No emitted row = the idempotency key already existed (a prior paid-claim run created it).
  // That's the designed no-op: the confirmation is already handled.
  if (!emailRow) {
    logStep("Player confirmation already enqueued (idempotent no-op)", { isGuest });
    return { ok: true, isGuest, pdfAttached, status: "already_enqueued" };
  }

  if (emailRow.status === "skipped") {
    logStep("Player confirmation skipped — no deliverable email", { isGuest, skipReason: emailRow.skip_reason });
    return { ok: false, reason: "skipped", isGuest, pdfAttached, outboxId: emailRow.outbox_id, status: "skipped", skipReason: emailRow.skip_reason ?? undefined };
  }

  logStep("Player confirmation enqueued", { isGuest, pdfAttached, outboxId: emailRow.outbox_id });
  return { ok: true, isGuest, pdfAttached, outboxId: emailRow.outbox_id, status: emailRow.status };
}

function normalizeLang(v: string | null | undefined): "nl" | "en" {
  return String(v ?? "").toLowerCase().slice(0, 2) === "en" ? "en" : "nl";
}

/**
 * Fetch (or rebuild) the invoice PDF for these bookings and return it as a Resend
 * base64 attachment. Best-effort: returns `{ attachments: undefined }` on any failure —
 * the confirmation must never be blocked by PDF generation (mirrors send-invoice-email).
 */
async function buildInvoiceAttachment(
  supabase: SupabaseClient,
  invoiceId: string | null,
  bookingIds: string[],
  logStep: LogStep,
): Promise<{ attachments?: Attachment[] }> {
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
