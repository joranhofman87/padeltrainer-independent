import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const CRITICAL_TABLES = [
  "profiles",
  "trainer_profiles",
  "bookings",
  "academy_profiles",
  "academy_managers",
  "availability_slots",
];

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  // Use anon client to trigger RLS evaluation
  const anonClient = createClient(supabaseUrl, anonKey);

  const results: { table: string; ok: boolean; error?: string; ms: number }[] = [];

  for (const table of CRITICAL_TABLES) {
    const start = Date.now();
    try {
      const { error } = await anonClient
        .from(table)
        .select("id")
        .limit(1);

      const ms = Date.now() - start;
      const hasRecursion = error?.message?.includes("infinite recursion");

      results.push({
        table,
        ok: !hasRecursion,
        ms,
        ...(error && { error: error.message }),
      });
    } catch (e) {
      results.push({
        table,
        ok: false,
        ms: Date.now() - start,
        error: String(e),
      });
    }
  }

  const hasRecursionError = results.some(
    (r) => !r.ok || (r.error && r.error.includes("infinite recursion"))
  );

  return new Response(
    JSON.stringify({
      status: hasRecursionError ? "recursion_detected" : "healthy",
      timestamp: new Date().toISOString(),
      results,
    }),
    {
      status: hasRecursionError ? 503 : 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
});
