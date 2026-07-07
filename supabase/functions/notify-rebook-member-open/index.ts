import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { resolveAppBase } from "../_shared/priority-claim-invite.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";
import { computeMemberOpenAudience, type MemberOpenClaim, type MemberOpenRecipient } from "../_shared/rebook-member-open.ts";

// Cron-invoked (service-role) notifier: when a rebook round's MEMBER window opens
// and seats have freed up, email the "second bucket" — the original-cohort players
// who didn't rebook + the registered priority list — that they can book now.
// Idempotent per round via cycles.settings.rebook_member_open_notified_at (claimed
// atomically before send; unclaimed on total failure so the next tick retries).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const APP_BASE = resolveAppBase(Deno.env.get("PUBLIC_APP_URL"));
const FROM = "PadelTrainer.ai <noreply@app.padeltrainer.ai>";
const MAX_CYCLES_PER_RUN = 20;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const substituteVars = (text: string, fullName: string) => {
  const full = (fullName || "").trim();
  const first = full.split(/\s+/)[0] || full;
  return text.replace(/\{first_name\}/g, first).replace(/\{full_name\}/g, full);
};
const renderCustomMessage = (message: string, fullName: string): string => {
  const msg = (message || "").trim();
  if (!msg) return "";
  const paras = substituteVars(msg, fullName)
    .split("\n")
    .map((line) => `<p style="color:#374151;line-height:1.6;margin:0 0 8px;">${escapeHtml(line)}</p>`)
    .join("");
  return `<div style="background:#ffffff;border-left:3px solid #f45d25;padding:8px 0 8px 14px;margin:16px 0;">${paras}</div>`;
};

async function sendWithRetry(
  resend: Resend,
  payload: { from: string; to: string[]; subject: string; html: string },
  maxAttempts = 4,
): Promise<{ error: unknown | null }> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { error } = await resend.emails.send(payload);
    if (!error) return { error: null };
    lastError = error;
    const e = error as { statusCode?: number; name?: string };
    const isRateLimit = e?.statusCode === 429 || e?.name === "rate_limit_exceeded" ||
      (e?.statusCode == null && /\b429\b|rate.?limit/i.test(JSON.stringify(error ?? {})));
    if (!isRateLimit) return { error };
    if (attempt < maxAttempts - 1) await sleep(800 * (attempt + 1));
  }
  return { error: lastError };
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

  // Service-role only (this is a cron/internal fn — no user path).
  const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  if (token !== serviceKey) return json({ error: "unauthorized" }, 401);
  if (!resendApiKey) return json({ error: "email_not_configured" }, 500);

  const supabase = createClient(supabaseUrl, serviceKey);
  const resend = new Resend(resendApiKey);

  try {
    const { data: cands, error: candErr } = await supabase.rpc("rebook_cycles_needing_member_open_notice");
    if (candErr) throw candErr;
    const cycleIds = ((cands ?? []) as Array<{ cycle_id: string }>).map((r) => r.cycle_id).slice(0, MAX_CYCLES_PER_RUN);

    let cyclesNotified = 0;
    let totalSent = 0;

    for (const cycleId of cycleIds) {
      // Atomic claim: stamp notified_at IF NULL. Lost race ⇒ another run has it.
      const { data: claimed } = await supabase.rpc("claim_rebook_member_open_notice", { _cycle_id: cycleId });
      if (claimed !== true) continue;

      try {
        const sent = await notifyCycle(supabase, resend, cycleId);
        totalSent += sent;
        cyclesNotified += 1;
      } catch (e) {
        // Total failure for this round → release the marker so the next tick retries.
        await supabase.rpc("unclaim_rebook_member_open_notice", { _cycle_id: cycleId });
        await notifySlackEdgeError("notify-rebook-member-open", e instanceof Error ? e.message : String(e), { cycleId });
      }
    }

    return json({ ok: true, cyclesNotified, totalSent });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await notifySlackEdgeError("notify-rebook-member-open", message);
    return json({ error: message }, 500);
  }
};

// Emails the second bucket for one round. Throws on a total send failure (0 sent,
// ≥1 attempted) so the caller can release the idempotency marker and retry later.
// The client is the untyped Deno service client (no generated Database types), so it
// is typed loosely here — results are shaped via explicit casts below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function notifyCycle(supabase: any, resend: Resend, cycleId: string): Promise<number> {
  // Cycle + academy context.
  const { data: cycle } = await supabase
    .from("cycles").select("id, name, owner_id, settings").eq("id", cycleId).maybeSingle();
  if (!cycle) return 0;
  const settings = (cycle.settings || {}) as Record<string, unknown>;
  const priorityPeople: string[] = Array.isArray(settings.rebook_priority_people)
    ? (settings.rebook_priority_people as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const customMessage = typeof settings.rebook_member_open_message === "string" ? settings.rebook_member_open_message : "";

  // The round's slots (source_cycle_id = this cycle) → their pending-window claims.
  const { data: slots } = await supabase
    .from("availability_slots").select("id, member_window_ends_at, academy_profile_id").eq("source_cycle_id", cycleId);
  const slotIds = ((slots ?? []) as Array<{ id: string }>).map((s) => s.id);
  if (slotIds.length === 0) return 0;
  const memberEnd = ((slots ?? []) as Array<{ member_window_ends_at: string | null }>)
    .map((s) => s.member_window_ends_at).filter((x): x is string => !!x).sort()[0] ?? null;
  const academyProfileId = ((slots ?? []) as Array<{ academy_profile_id: string | null }>)
    .find((s) => s.academy_profile_id)?.academy_profile_id ?? cycle.owner_id;

  const claims: MemberOpenClaim[] = [];
  for (let i = 0; i < slotIds.length; i += 200) {
    const { data: rows } = await supabase
      .from("slot_priority_claims")
      .select("player_id, guest_player_id, status, response_intent")
      .in("slot_id", slotIds.slice(i, i + 200));
    claims.push(...((rows ?? []) as MemberOpenClaim[]));
  }

  const audience = computeMemberOpenAudience(claims, priorityPeople);
  if (audience.length === 0) return 0;

  // Resolve names + emails; drop anyone without an email.
  const playerIds = audience.map((a) => a.player_id).filter((x): x is string => !!x);
  const guestIds = audience.map((a) => a.guest_player_id).filter((x): x is string => !!x);
  const [{ data: profiles }, { data: guests }] = await Promise.all([
    playerIds.length ? supabase.from("profiles").select("id, full_name, email").in("id", playerIds) : Promise.resolve({ data: [] }),
    guestIds.length ? supabase.from("guest_players").select("id, full_name, email").in("id", guestIds) : Promise.resolve({ data: [] }),
  ]);
  const infoByKey = new Map<string, { name: string; email: string }>();
  for (const p of (profiles ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>) {
    if (p.email?.trim()) infoByKey.set(p.id, { name: (p.full_name ?? "").trim(), email: p.email.trim() });
  }
  for (const g of (guests ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>) {
    if (g.email?.trim()) infoByKey.set(`g:${g.id}`, { name: (g.full_name ?? "").trim(), email: g.email.trim() });
  }
  const keyOf = (a: MemberOpenRecipient) => a.player_id ?? (a.guest_player_id ? `g:${a.guest_player_id}` : "");
  const recipients = audience.map((a) => infoByKey.get(keyOf(a))).filter((r): r is { name: string; email: string } => !!r);
  if (recipients.length === 0) return 0;

  // Academy slug + timezone for the deep-link + deadline formatting.
  const { data: academy } = academyProfileId
    ? await supabase.from("academy_profiles").select("slug, timezone").eq("id", academyProfileId).maybeSingle()
    : { data: null };
  const slug = (academy as { slug?: string | null } | null)?.slug ?? null;
  const tz = (academy as { timezone?: string | null } | null)?.timezone || "Europe/Amsterdam";
  const bookUrl = slug ? `${APP_BASE}/nl/academies/${slug}?cycle=${cycleId}` : `${APP_BASE}/nl`;
  const deadline = memberEnd
    ? new Date(memberEnd).toLocaleDateString("nl-NL", { day: "numeric", month: "long", timeZone: tz })
    : null;

  let sent = 0;
  let failed = 0;
  for (const r of recipients) {
    if (sent > 0 || failed > 0) await sleep(120);
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color:#1a1a1a;">
        <h2 style="margin:0 0 12px;">Er zijn plekken vrijgekomen${cycle.name ? ` (${escapeHtml(String(cycle.name))})` : ""}</h2>
        <p style="color:#374151;line-height:1.6;">${r.name ? `Hi ${escapeHtml(r.name)},` : "Hi,"}</p>
        ${renderCustomMessage(customMessage, r.name)}
        <p style="color:#374151;line-height:1.6;">Er zijn plekken vrijgekomen voor de volgende ronde en jij mag als eerste boeken — vóór het publiek.</p>
        ${deadline ? `<p style="color:#6b7280;font-size:13px;">Je hebt voorrang tot <strong>${deadline}</strong>. Daarna komen de plekken vrij voor iedereen.</p>` : ""}
        <div style="text-align:center;margin:28px 0;">
          <a href="${bookUrl}" style="display:inline-block;background:#16a34a;color:white;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Bekijk vrije plekken</a>
        </div>
        <p style="color:#9ca3af;font-size:12px;text-align:center;">Of open deze link: <a href="${bookUrl}" style="color:#f45d25;">${bookUrl}</a></p>
      </div>`;
    const { error } = await sendWithRetry(resend, {
      from: FROM,
      to: [r.email],
      subject: "Er zijn plekken vrijgekomen — jij mag als eerste boeken",
      html,
    });
    if (error) { failed++; console.error("member-open send error", error); } else { sent++; }
  }

  // Total failure with recipients present → signal the caller to retry the whole round.
  if (sent === 0 && failed > 0) {
    throw new Error(`all ${failed} member-open emails failed for cycle ${cycleId}`);
  }
  return sent;
}

serve(handler);
