import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[ADMIN-STATS] ${step}${detailsStr}`);
};

// Platform flat fees by tier (€ per booking)
const TIER_FLAT_FEES: Record<string, number> = {
  starter: 1.00,
  professional: 0.75,
  academy: 0.50,
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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
      .eq("role", "admin")
      .maybeSingle();

    if (!roleData) {
      logStep("Access denied - not admin", { userId: user.id });
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logStep("Admin access verified");

    const now = new Date();

    // Fetch all required data in parallel
    const [
      bookingsResult,
      trainersResult,
      playersResult,
      mollieAccountsResult,
      clubsResult,
    ] = await Promise.all([
      supabase
        .from("bookings")
        .select("id, payment_amount, payment_status, paid_at, created_at, slot_id"),
      supabase
        .from("trainer_profiles")
        .select("id, user_id, subscription_status, created_at"),
      supabase
        .from("profiles")
        .select("id, user_id, created_at"),
      supabase
        .from("trainer_mollie_accounts")
        .select("trainer_id, charges_enabled, payouts_enabled, onboarding_complete"),
      supabase
        .from("club_profiles")
        .select("id, is_verified, subscription_status, subscription_tier, trial_ends_at"),
    ]);

    const bookings = bookingsResult.data || [];
    const trainers = trainersResult.data || [];
    const players = playersResult.data || [];
    const mollieAccounts = mollieAccountsResult.data || [];
    const clubs = clubsResult.data || [];

    logStep("Data fetched", {
      bookings: bookings.length,
      trainers: trainers.length,
      players: players.length,
      mollieAccounts: mollieAccounts.length,
      clubs: clubs.length,
    });

    // Calculate signup trends (this month vs last month)
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

    const trainersThisMonth = trainers.filter(t => 
      t.created_at && new Date(t.created_at) >= thisMonthStart
    ).length;
    const trainersLastMonth = trainers.filter(t => 
      t.created_at && new Date(t.created_at) >= lastMonthStart && new Date(t.created_at) <= lastMonthEnd
    ).length;
    const trainerTrend = trainersLastMonth > 0 
      ? ((trainersThisMonth - trainersLastMonth) / trainersLastMonth) * 100 
      : trainersThisMonth > 0 ? 100 : 0;

    const playersThisMonth = players.filter(p => 
      p.created_at && new Date(p.created_at) >= thisMonthStart
    ).length;
    const playersLastMonth = players.filter(p => 
      p.created_at && new Date(p.created_at) >= lastMonthStart && new Date(p.created_at) <= lastMonthEnd
    ).length;
    const playerTrend = playersLastMonth > 0 
      ? ((playersThisMonth - playersLastMonth) / playersLastMonth) * 100 
      : playersThisMonth > 0 ? 100 : 0;

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

    // Estimate platform fees using flat fee per booking
    const totalTrainers = trainers.length || 1;
    const estimatedPlatformFees = 
      (trainerTiers.starter * TIER_FLAT_FEES.starter) +
      (trainerTiers.professional * TIER_FLAT_FEES.professional) +
      (trainerTiers.academy * TIER_FLAT_FEES.academy);
    // Weight by bookings (rough estimate: distribute paid bookings proportionally by trainer count)
    const totalPaidBookings = paidBookings.length;
    const avgFeeFlat = totalPaidBookings > 0
      ? (
          ((trainerTiers.starter / totalTrainers) * TIER_FLAT_FEES.starter) +
          ((trainerTiers.professional / totalTrainers) * TIER_FLAT_FEES.professional) +
          ((trainerTiers.academy / totalTrainers) * TIER_FLAT_FEES.academy)
        )
      : TIER_FLAT_FEES.starter;
    const estimatedTotalFees = totalPaidBookings * avgFeeFlat;

    // Mollie Connect stats
    const connectedAccounts = mollieAccounts.filter(a => a.charges_enabled).length;
    const pendingAccounts = mollieAccounts.filter(a => !a.charges_enabled).length;

    // Club stats
    const clubStats = {
      total: clubs.length,
      verified: clubs.filter(c => c.is_verified).length,
      subscribed: clubs.filter(c => c.subscription_status === "active").length,
      trialing: clubs.filter(c => {
        if (c.subscription_status !== "trial") return false;
        if (!c.trial_ends_at) return true;
        return new Date(c.trial_ends_at) > now;
      }).length,
      expired: clubs.filter(c => {
        if (c.subscription_status === "active") return false;
        if (!c.trial_ends_at) return false;
        return new Date(c.trial_ends_at) <= now;
      }).length,
    };

    // Monthly stats (last 6 months)
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
      const monthFees = monthBookings.length * avgFeeFlat;

      monthlyStats.push({
        month: monthName,
        gmv: monthGMV,
        fees: monthFees,
        bookings: monthBookings.length,
      });
    }

    const response = {
      overview: {
        totalGMV,
        platformFees: estimatedTotalFees,
        avgFeeFlat,
        totalBookings: bookings.length,
        paidBookings: paidBookings.length,
        activeTrainers: trainers.length,
        activePlayers: players.length,
        connectedAccounts,
        pendingAccounts,
        totalClubs: clubStats.total,
        verifiedClubs: clubStats.verified,
        subscribedClubs: clubStats.subscribed,
        trialingClubs: clubStats.trialing,
        expiredTrialClubs: clubStats.expired,
      },
      signupTrends: {
        trainersThisMonth,
        trainersLastMonth,
        trainerTrend,
        playersThisMonth,
        playersLastMonth,
        playerTrend,
      },
      trainersByTier: trainerTiers,
      clubStats,
      monthlyStats,
    };

    logStep("Response prepared", { totalGMV, platformFees: estimatedTotalFees });

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
