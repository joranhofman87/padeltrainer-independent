import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[ADMIN-STATS] ${step}${detailsStr}`);
};

// Platform fee percentages by tier
const TIER_FEES: Record<string, number> = {
  starter: 10,
  professional: 5,
  academy: 2.5,
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      throw new Error("No authorization header");
    }

    // Create client with user's token to verify identity
    const supabaseUser = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      throw new Error("Unauthorized");
    }

    logStep("User authenticated", { userId: user.id });

    // Use service role client for admin checks and data fetching
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Check if user is admin
    const { data: roleData } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .single();

    if (!roleData || roleData.role !== "admin") {
      logStep("Access denied - not admin", { role: roleData?.role });
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logStep("Admin access verified");

    // Fetch all required data in parallel
    const [
      bookingsResult,
      trainersResult,
      playersResult,
      stripeAccountsResult,
    ] = await Promise.all([
      supabase
        .from("bookings")
        .select("id, payment_amount, payment_status, paid_at, created_at, slot_id"),
      supabase
        .from("trainer_profiles")
        .select("id, user_id, subscription_status"),
      supabase
        .from("profiles")
        .select("id, user_id"),
      supabase
        .from("trainer_stripe_accounts")
        .select("trainer_id, charges_enabled, payouts_enabled, onboarding_complete"),
    ]);

    const bookings = bookingsResult.data || [];
    const trainers = trainersResult.data || [];
    const players = playersResult.data || [];
    const stripeAccounts = stripeAccountsResult.data || [];

    logStep("Data fetched", {
      bookings: bookings.length,
      trainers: trainers.length,
      players: players.length,
      stripeAccounts: stripeAccounts.length,
    });

    // Calculate stats
    const paidBookings = bookings.filter(b => b.payment_status === "paid");
    const totalGMV = paidBookings.reduce((sum, b) => sum + (Number(b.payment_amount) || 0), 0);
    
    // Calculate platform fees based on trainer tiers
    // For simplicity, we estimate based on current subscription statuses
    const trainerTiers: Record<string, number> = {
      starter: 0,
      professional: 0,
      academy: 0,
    };

    trainers.forEach(t => {
      const status = t.subscription_status || "inactive";
      if (status === "professional" || status === "active") {
        trainerTiers.professional++;
      } else if (status === "academy") {
        trainerTiers.academy++;
      } else {
        trainerTiers.starter++;
      }
    });

    // Estimate platform fees (weighted average based on current tier distribution)
    const totalTrainers = trainers.length || 1;
    const avgFeePercent = (
      (trainerTiers.starter * TIER_FEES.starter) +
      (trainerTiers.professional * TIER_FEES.professional) +
      (trainerTiers.academy * TIER_FEES.academy)
    ) / totalTrainers;
    
    const estimatedPlatformFees = totalGMV * (avgFeePercent / 100);

    // Stripe Connect stats
    const connectedAccounts = stripeAccounts.filter(a => a.charges_enabled).length;
    const pendingAccounts = stripeAccounts.filter(a => !a.charges_enabled).length;

    // Monthly stats (last 6 months)
    const now = new Date();
    const monthlyStats: Array<{
      month: string;
      gmv: number;
      fees: number;
      bookings: number;
    }> = [];

    for (let i = 5; i >= 0; i--) {
      const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
      const monthName = monthDate.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
      
      const monthBookings = paidBookings.filter(b => {
        const paidDate = b.paid_at ? new Date(b.paid_at) : new Date(b.created_at);
        return paidDate >= monthDate && paidDate <= monthEnd;
      });

      const monthGMV = monthBookings.reduce((sum, b) => sum + (Number(b.payment_amount) || 0), 0);
      const monthFees = monthGMV * (avgFeePercent / 100);

      monthlyStats.push({
        month: monthName,
        gmv: monthGMV,
        fees: monthFees,
        bookings: monthBookings.length,
      });
    }

    // Get Stripe platform balance if available
    let stripeBalance: {
      available: Array<{ amount: number; currency: string }>;
      pending: Array<{ amount: number; currency: string }>;
    } | null = null;
    if (stripeSecretKey) {
      try {
        const stripe = new Stripe(stripeSecretKey, {
          apiVersion: "2023-10-16",
        });
        const balance = await stripe.balance.retrieve();
        stripeBalance = {
          available: balance.available.map((b: { amount: number; currency: string }) => ({
            amount: b.amount / 100,
            currency: b.currency.toUpperCase(),
          })),
          pending: balance.pending.map((b: { amount: number; currency: string }) => ({
            amount: b.amount / 100,
            currency: b.currency.toUpperCase(),
          })),
        };
        logStep("Stripe balance retrieved", stripeBalance);
      } catch (stripeError) {
        logStep("Stripe balance error", { error: (stripeError as Error).message });
      }
    }

    const response = {
      overview: {
        totalGMV,
        platformFees: estimatedPlatformFees,
        avgFeePercent,
        totalBookings: bookings.length,
        paidBookings: paidBookings.length,
        activeTrainers: trainers.length,
        activePlayers: players.length,
        connectedAccounts,
        pendingAccounts,
      },
      trainersByTier: trainerTiers,
      monthlyStats,
      stripeBalance,
    };

    logStep("Response prepared", { totalGMV, platformFees: estimatedPlatformFees });

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logStep("Error", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
