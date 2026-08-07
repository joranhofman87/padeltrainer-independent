import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { requireServiceRole } from "../_shared/auth.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";
import { gateDigestItems, normalizeEmailForSuppression } from "../_shared/digest-send-gate.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));

interface QueueItem {
  id: string;
  user_id: string;
  notification_type: string;
  payload: Record<string, unknown>;
  scheduled_for: string;
  created_at: string;
}

const EMAIL_LOGO = `<div style="text-align: center; margin-bottom: 24px;"><img src="https://padeltrainer.ai/logo-dark.png" alt="PadelTrainer.ai" width="220" height="40" style="max-width: 220px; height: auto;" /></div>`;
const BRAND_ORANGE = "#f45d25";

function buildDigestHtml(
  items: QueueItem[],
  userName: string,
  role: string
): { subject: string; html: string } {
  const grouped: Record<string, QueueItem[]> = {};
  for (const item of items) {
    const type = item.notification_type;
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(item);
  }

  const sections: string[] = [];

  if (grouped["new_booking"]) {
    const count = grouped["new_booking"].length;
    sections.push(`<p>📅 <strong>${count} new booking${count > 1 ? "s" : ""}</strong></p>`);
  }
  if (grouped["booking_cancelled"]) {
    const count = grouped["booking_cancelled"].length;
    sections.push(`<p>❌ <strong>${count} cancelled booking${count > 1 ? "s" : ""}</strong></p>`);
  }
  if (grouped["new_follower"]) {
    const count = grouped["new_follower"].length;
    sections.push(`<p>👤 <strong>${count} new follower${count > 1 ? "s" : ""}</strong></p>`);
  }
  if (grouped["new_player"]) {
    const count = grouped["new_player"].length;
    sections.push(`<p>🎾 <strong>${count} new player${count > 1 ? "s" : ""}</strong></p>`);
  }
  if (grouped["new_registration"]) {
    const count = grouped["new_registration"].length;
    sections.push(`<p>📝 <strong>${count} new registration${count > 1 ? "s" : ""}</strong></p>`);
  }
  if (grouped["new_review"]) {
    const count = grouped["new_review"].length;
    sections.push(`<p>⭐ <strong>${count} new review${count > 1 ? "s" : ""}</strong></p>`);
  }
  if (grouped["open_slots_digest"]) {
    const count = grouped["open_slots_digest"].length;
    sections.push(`<p>📅 <strong>${count} new open slot${count > 1 ? "s" : ""} from trainers you follow</strong></p>`);
  }
  if (grouped["booking_confirmation"]) {
    const count = grouped["booking_confirmation"].length;
    sections.push(`<p>✅ <strong>${count} booking confirmation${count > 1 ? "s" : ""}</strong></p>`);
  }
  if (grouped["booking_reminder"]) {
    const count = grouped["booking_reminder"].length;
    sections.push(`<p>🔔 <strong>${count} upcoming session${count > 1 ? "s" : ""}</strong></p>`);
  }
  if (grouped["payment_receipt"] || grouped["payment_received"]) {
    const count = (grouped["payment_receipt"]?.length || 0) + (grouped["payment_received"]?.length || 0);
    sections.push(`<p>💳 <strong>${count} payment${count > 1 ? "s" : ""}</strong></p>`);
  }
  if (grouped["waitlist_update"]) {
    const count = grouped["waitlist_update"].length;
    sections.push(`<p>📋 <strong>${count} waitlist update${count > 1 ? "s" : ""}</strong></p>`);
  }

  // Fallback for any unknown types
  for (const [type, typeItems] of Object.entries(grouped)) {
    const knownTypes = [
      "new_booking", "booking_cancelled", "new_follower", "new_player",
      "new_registration", "new_review", "open_slots_digest", "booking_confirmation",
      "booking_reminder", "payment_receipt", "payment_received", "waitlist_update",
    ];
    if (!knownTypes.includes(type)) {
      sections.push(`<p>📌 <strong>${typeItems.length} ${type.replace(/_/g, " ")} notification${typeItems.length > 1 ? "s" : ""}</strong></p>`);
    }
  }

  const frequency = items[0]?.scheduled_for === "weekly" ? "weekly" : "daily";
  const dashboardPath = role === "player" ? "/app/player" : role === "trainer" ? "/app/trainer" : "/app/academy";

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      ${EMAIL_LOGO}
      <h1 style="color: ${BRAND_ORANGE};">Your ${frequency === "weekly" ? "Weekly" : "Daily"} Summary 📊</h1>
      <p>Hi ${userName},</p>
      <p>Here's what happened ${frequency === "weekly" ? "this week" : "today"}:</p>
      <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
        ${sections.join("")}
      </div>
      <p style="margin-top: 24px;">
        <a href="https://padeltrainer.ai${dashboardPath}" style="background: ${BRAND_ORANGE}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Go to Dashboard</a>
      </p>
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
      <p style="color: #6b7280; font-size: 14px;">
        You're receiving this digest from PadelTrainer.ai.<br/>
        <a href="https://padeltrainer.ai/app/settings/notifications" style="color: #6b7280;">Manage email notifications</a>
      </p>
    </div>
  `;

  return {
    subject: `Your ${frequency === "weekly" ? "Weekly" : "Daily"} PadelTrainer.ai Summary`,
    html,
  };
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Digest flush is a scheduled server-to-server job — cron only.
  const guard = requireServiceRole(req);
  if (guard) return guard;

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    let frequency = "daily";
    try {
      const body = await req.json();
      if (body.frequency === "weekly") frequency = "weekly";
    } catch {
      // Default to daily
    }

    console.log(`Processing ${frequency} digest emails...`);

    // Fetch pending candidate ids only. Claiming happens per-user below (with
    // processed_at as the claim marker, since the table has no status column),
    // so a crash mid-run strands at most one user's items — not the whole batch.
    const { data: queueItems, error: qErr } = await supabaseAdmin
      .from("notification_queue")
      .select("id, user_id")
      .eq("scheduled_for", frequency)
      .is("processed_at", null)
      .order("created_at", { ascending: true })
      .limit(1000);

    if (qErr) {
      console.error("Error fetching queue:", qErr);
      throw qErr;
    }

    if (!queueItems || queueItems.length === 0) {
      console.log("No pending digest items");
      return new Response(JSON.stringify({ processed: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Group candidate ids by user_id
    const byUser: Record<string, string[]> = {};
    for (const item of queueItems as { id: string; user_id: string }[]) {
      if (!byUser[item.user_id]) byUser[item.user_id] = [];
      byUser[item.user_id].push(item.id);
    }

    const userIds = Object.keys(byUser);
    console.log(`Processing digests for ${userIds.length} users`);

    // Fetch user profiles and roles BEFORE claiming anything: a failed profile
    // fetch must abort the run, not consume claimed items as "no email".
    const { data: profiles, error: profErr } = await supabaseAdmin
      .from("profiles")
      .select("user_id, email, full_name")
      .in("user_id", userIds);

    if (profErr) {
      console.error("Error fetching profiles:", profErr);
      throw profErr;
    }

    const { data: userRoles, error: rolesErr } = await supabaseAdmin
      .from("user_roles")
      .select("user_id, role")
      .in("user_id", userIds);

    if (rolesErr) {
      // Non-fatal: digest content only uses role for the dashboard link.
      console.error("Error fetching roles (defaulting to player):", rolesErr);
    }

    const profileMap: Record<string, { email: string; name: string }> = {};
    for (const p of profiles || []) {
      profileMap[p.user_id] = { email: p.email, name: p.full_name || "there" };
    }

    const roleMap: Record<string, string> = {};
    for (const r of userRoles || []) {
      roleMap[r.user_id] = r.role;
    }

    // N2 S2b — the SEND-TIME gate's inputs, read BEFORE anything is claimed so a failed read
    // aborts the whole run with nothing consumed (same fail-closed shape as the profile fetch
    // above). The gap this closes: items queue when the preference says daily/weekly and flush
    // days later — someone who opted out in between still got the digest, and a hard-bounced
    // address was retried forever. Only an explicit CURRENT 'off' refuses (the J rule); a
    // suppressed address is consumed without sending, because it provably cannot receive and
    // releasing it would loop forever.
    const { data: prefRows, error: prefsErr } = await supabaseAdmin
      .from("notification_preferences")
      .select("*")
      .in("user_id", userIds);
    if (prefsErr) {
      console.error("Error fetching notification preferences (aborting before claim):", prefsErr);
      throw prefsErr;
    }
    const prefsMap: Record<string, Record<string, unknown>> = {};
    for (const row of (prefRows || []) as Array<Record<string, unknown>>) {
      prefsMap[String(row.user_id)] = row;
    }

    // Deduplicated + CHUNKED: `.in()` rides in the request URL, and up to 1000 raw email strings
    // can exceed proxy/PostgREST URI limits — which would trip the pre-claim abort below on EVERY
    // run over the same leading batch, starving the whole queue. 100 addresses per query keeps
    // each URL bounded regardless of address length.
    const normalizedEmails = [...new Set(
      Object.values(profileMap)
        .map((p) => (p.email ? normalizeEmailForSuppression(p.email) : null))
        .filter((e): e is string => !!e),
    )];
    const SUPPRESSION_CHUNK = 100;
    const suppressedSet = new Set<string>();
    for (let i = 0; i < normalizedEmails.length; i += SUPPRESSION_CHUNK) {
      // email_address_state stores addresses normalized (lower/btrim) — the same normalization
      // normalizeEmailForSuppression applies — and is_suppressed is the canonical generated
      // predicate is_email_suppressed() reads. A read failure aborts: we cannot prove any
      // address is safe to send to, and nothing is claimed yet.
      const chunk = normalizedEmails.slice(i, i + SUPPRESSION_CHUNK);
      const { data: suppressedRows, error: suppErr } = await supabaseAdmin
        .from("email_address_state")
        .select("email")
        .in("email", chunk)
        .eq("is_suppressed", true);
      if (suppErr) {
        console.error("Error fetching suppression state (aborting before claim):", suppErr);
        throw suppErr;
      }
      for (const r of (suppressedRows || []) as Array<{ email: string }>) suppressedSet.add(r.email);
    }

    let processed = 0;
    let consumed = 0;
    let failedUsers = 0;
    let releasedItems = 0;
    let droppedSuppressedUsers = 0;
    let droppedOffItems = 0;

    for (const userId of userIds) {
      // Atomic claim: only rows this UPDATE flips from NULL belong to this run;
      // a concurrent run claims zero of them and cannot double-send.
      const { data: claimed, error: claimErr } = await supabaseAdmin
        .from("notification_queue")
        .update({ processed_at: new Date().toISOString() })
        .in("id", byUser[userId])
        .is("processed_at", null)
        .select("*");

      if (claimErr) {
        console.error(`Error claiming items for user ${userId}:`, claimErr);
        continue;
      }
      if (!claimed || claimed.length === 0) {
        // Another run already claimed this user's items.
        continue;
      }

      const items = claimed as QueueItem[];
      const profile = profileMap[userId];
      if (!profile?.email) {
        // No address to retry against — keep the items consumed.
        console.log(`No email for user ${userId}, skipping`);
        consumed += items.length;
        continue;
      }

      // SEND-TIME GATE (N2 S2b). Both drops CONSUME the claim rather than releasing it: a
      // suppressed address cannot receive (releasing loops forever), and an opted-out item is a
      // decision already taken, not a queue awaiting drainage.
      if (suppressedSet.has(normalizeEmailForSuppression(profile.email))) {
        console.log(`Address suppressed for user ${userId} — digest dropped (${items.length} items)`);
        consumed += items.length;
        droppedSuppressedUsers++;
        continue;
      }

      const gate = gateDigestItems(items, prefsMap[userId] ?? null);
      if (gate.droppedOff.length > 0) {
        console.log(`User ${userId} opted out since enqueue — dropping ${gate.droppedOff.length} item(s)`);
        consumed += gate.droppedOff.length;
        droppedOffItems += gate.droppedOff.length;
      }
      if (gate.send.length === 0) {
        // Everything this user had queued has since been opted out of — nothing to send.
        continue;
      }

      const role = roleMap[userId] || "player";
      const { subject, html } = buildDigestHtml(gate.send, profile.name, role);

      try {
        // Resend's SDK reports API failures via the error field, not by throwing.
        const { error: sendErr } = await resend.emails.send({
          from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>",
          to: [profile.email],
          subject,
          html,
        });
        if (sendErr) throw sendErr;
        processed++;
        consumed += gate.send.length;
      } catch (emailErr) {
        console.error(`Failed to send digest to user ${userId}:`, emailErr);
        failedUsers++;
        // Release ONLY the items we tried to send, so the next run retries this user's digest.
        // The opted-out items stay consumed — releasing them would resurrect rows whose refusal
        // was already decided, and the gate would just drop them again next run.
        const { error: releaseErr } = await supabaseAdmin
          .from("notification_queue")
          .update({ processed_at: null })
          .in("id", gate.send.map((i) => i.id));
        if (releaseErr) {
          console.error(`Error releasing claimed items for user ${userId} (digest lost):`, releaseErr);
        } else {
          releasedItems += gate.send.length;
        }
      }
    }

    console.log(
      `Digest complete: ${processed} emails sent, ${consumed} items processed, ${failedUsers} users failed (${releasedItems} items released for retry), ${droppedSuppressedUsers} suppressed user(s) dropped, ${droppedOffItems} opted-out item(s) dropped`
    );

    // Per-user send failures return HTTP 200, so the daily-emails cron wrapper's
    // alertCronFailure (non-2xx only) never sees them. Their queue items were
    // released for retry, but a persistent failure would silently loop — alert.
    if (failedUsers > 0) {
      await notifySlackEdgeError(
        "send-digest-emails",
        `${failedUsers} user digest(s) failed to send`,
        { failedUsers, processed, releasedItems },
      );
    }

    return new Response(
      JSON.stringify({ processed, items: consumed, failed: failedUsers, released: releasedItems, suppressed_users: droppedSuppressedUsers, opted_out_items: droppedOffItems }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  } catch (error) {
    console.error("Error in send-digest-emails:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
};

serve(handler);
