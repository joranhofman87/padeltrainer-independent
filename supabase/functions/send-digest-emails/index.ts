import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";

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
  payload: Record<string, any>;
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
        <a href="https://padeltrainer.ai${dashboardPath}/settings/notifications" style="color: #6b7280;">Manage email notifications</a>
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

    // Fetch unprocessed queue items
    const { data: queueItems, error: qErr } = await supabaseAdmin
      .from("notification_queue")
      .select("*")
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

    // Group by user_id
    const byUser: Record<string, QueueItem[]> = {};
    for (const item of queueItems as QueueItem[]) {
      if (!byUser[item.user_id]) byUser[item.user_id] = [];
      byUser[item.user_id].push(item);
    }

    const userIds = Object.keys(byUser);
    console.log(`Processing digests for ${userIds.length} users`);

    // Fetch user profiles and roles
    const { data: profiles } = await supabaseAdmin
      .from("profiles")
      .select("user_id, email, full_name")
      .in("user_id", userIds);

    const { data: userRoles } = await supabaseAdmin
      .from("user_roles")
      .select("user_id, role")
      .in("user_id", userIds);

    const profileMap: Record<string, { email: string; name: string }> = {};
    for (const p of profiles || []) {
      profileMap[p.user_id] = { email: p.email, name: p.full_name || "there" };
    }

    const roleMap: Record<string, string> = {};
    for (const r of userRoles || []) {
      roleMap[r.user_id] = r.role;
    }

    let processed = 0;
    const processedIds: string[] = [];

    for (const userId of userIds) {
      const items = byUser[userId];
      const profile = profileMap[userId];
      if (!profile?.email) {
        console.log(`No email for user ${userId}, skipping`);
        processedIds.push(...items.map((i) => i.id));
        continue;
      }

      const role = roleMap[userId] || "player";
      const { subject, html } = buildDigestHtml(items, profile.name, role);

      try {
        await resend.emails.send({
          from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>",
          to: [profile.email],
          subject,
          html,
        });
        processed++;
      } catch (emailErr) {
        console.error(`Failed to send digest to ${profile.email}:`, emailErr);
      }

      processedIds.push(...items.map((i) => i.id));
    }

    // Mark all as processed
    if (processedIds.length > 0) {
      const { error: updateErr } = await supabaseAdmin
        .from("notification_queue")
        .update({ processed_at: new Date().toISOString() })
        .in("id", processedIds);

      if (updateErr) {
        console.error("Error marking items processed:", updateErr);
      }
    }

    console.log(`Digest complete: ${processed} emails sent, ${processedIds.length} items processed`);

    return new Response(
      JSON.stringify({ processed, items: processedIds.length }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  } catch (error: any) {
    console.error("Error in send-digest-emails:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
};

serve(handler);
