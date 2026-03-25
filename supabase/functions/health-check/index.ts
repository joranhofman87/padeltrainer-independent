import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const start = Date.now();
  const checks: Record<string, { ok: boolean; ms?: number; error?: string }> = {};

  // 1. Database connectivity
  try {
    const dbStart = Date.now();
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { error } = await supabase
      .from("subscription_plans")
      .select("id")
      .limit(1)
      .single();

    checks.database = error
      ? { ok: false, ms: Date.now() - dbStart, error: error.message }
      : { ok: true, ms: Date.now() - dbStart };
  } catch (e) {
    checks.database = { ok: false, error: String(e) };
  }

  // 2. RLS recursion smoke check
  try {
    const rlsStart = Date.now();
    const supabaseUrl2 = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const anonClient = createClient(supabaseUrl2, anonKey);

    const rlsTables = ["profiles", "trainer_profiles", "bookings"];
    const rlsErrors: string[] = [];

    for (const table of rlsTables) {
      const { error } = await anonClient.from(table).select("id").limit(1);
      if (error?.message?.includes("infinite recursion")) {
        rlsErrors.push(`${table}: ${error.message}`);
      }
    }

    checks.rls_recursion = rlsErrors.length > 0
      ? { ok: false, ms: Date.now() - rlsStart, error: rlsErrors.join("; ") }
      : { ok: true, ms: Date.now() - rlsStart };
  } catch (e) {
    checks.rls_recursion = { ok: false, error: String(e) };
  }

  // 3. Critical secrets present
  const requiredSecrets = ["MOLLIE_API_KEY", "RESEND_API_KEY", "SLACK_WEBHOOK_URL"];
  const missingSecrets = requiredSecrets.filter((s) => !Deno.env.get(s));
  checks.secrets = {
    ok: missingSecrets.length === 0,
    ...(missingSecrets.length > 0 && { error: `Missing: ${missingSecrets.join(", ")}` }),
  };

  const allOk = Object.values(checks).every((c) => c.ok);

  return new Response(
    JSON.stringify({
      status: allOk ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      uptime_ms: Date.now() - start,
      checks,
    }),
    {
      status: allOk ? 200 : 503,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
});
