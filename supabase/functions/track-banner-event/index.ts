import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { banner_id, placement_id, event_type, page_url, session_id } =
      await req.json();

    if (!banner_id || !event_type || !session_id) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!["impression", "click"].includes(event_type)) {
      return new Response(
        JSON.stringify({ error: "Invalid event_type" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Hash IP for privacy-safe dedup
    const forwarded = req.headers.get("x-forwarded-for");
    const ip = forwarded?.split(",")[0]?.trim() || "unknown";
    const encoder = new TextEncoder();
    const data = encoder.encode(ip + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const ipHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Dedup: same session + banner + placement + event_type within 30 min
    if (event_type === "impression") {
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const { data: existing } = await supabase
        .from("banner_events")
        .select("id")
        .eq("session_id", session_id)
        .eq("banner_id", banner_id)
        .eq("event_type", "impression")
        .gte("created_at", thirtyMinAgo)
        .limit(1);

      if (existing && existing.length > 0) {
        return new Response(
          JSON.stringify({ ok: true, deduplicated: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Insert event
    const { error: insertError } = await supabase.from("banner_events").insert({
      banner_id,
      placement_id: placement_id || null,
      event_type,
      session_id,
      page_url: page_url || null,
      referrer: req.headers.get("referer") || null,
      user_agent: req.headers.get("user-agent") || null,
      ip_hash: ipHash,
    });

    if (insertError) throw insertError;

    // Increment aggregate counter
    const column = event_type === "click" ? "click_count" : "impression_count";
    const { data: banner } = await supabase
      .from("partner_banners")
      .select(`${column}, budget_type, budget_cap, is_active`)
      .eq("id", banner_id)
      .single();

    if (banner) {
      const bannerAny = banner as Record<string, unknown>;
      const newCount = ((bannerAny[column] as number) || 0) + 1;
      const updatePayload: Record<string, unknown> = { [column]: newCount };

      // Check budget cap
      if (
        banner.is_active &&
        banner.budget_cap &&
        ((banner.budget_type === "impression_cap" && event_type === "impression" && newCount >= banner.budget_cap) ||
          (banner.budget_type === "click_cap" && event_type === "click" && newCount >= banner.budget_cap))
      ) {
        updatePayload.is_active = false;
      }

      await supabase
        .from("partner_banners")
        .update(updatePayload)
        .eq("id", banner_id);
    }

    return new Response(
      JSON.stringify({ ok: true }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
