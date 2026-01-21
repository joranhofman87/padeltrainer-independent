import { supabase } from "@/integrations/supabase/client";

export interface AdminStats {
  overview: {
    totalGMV: number;
    platformFees: number;
    avgFeePercent: number;
    totalBookings: number;
    paidBookings: number;
    activeTrainers: number;
    activePlayers: number;
    connectedAccounts: number;
    pendingAccounts: number;
    totalClubs: number;
    verifiedClubs: number;
    subscribedClubs: number;
    trialingClubs: number;
    expiredTrialClubs: number;
  };
  signupTrends: {
    trainersThisMonth: number;
    trainersLastMonth: number;
    trainerTrend: number;
    playersThisMonth: number;
    playersLastMonth: number;
    playerTrend: number;
  };
  trainersByTier: {
    starter: number;
    professional: number;
    academy: number;
  };
  clubStats: {
    total: number;
    verified: number;
    subscribed: number;
    trialing: number;
    expired: number;
  };
  monthlyStats: Array<{
    month: string;
    gmv: number;
    fees: number;
    bookings: number;
  }>;
  stripeBalance: {
    available: Array<{ amount: number; currency: string }>;
    pending: Array<{ amount: number; currency: string }>;
  } | null;
}

export async function getAdminStats(): Promise<AdminStats> {
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session) {
    throw new Error("Not authenticated");
  }

  const response = await supabase.functions.invoke("get-admin-stats", {
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  if (response.error) {
    throw new Error(response.error.message || "Failed to fetch admin stats");
  }

  return response.data as AdminStats;
}

export async function isUserAdmin(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .single();

  if (error || !data) return false;
  return data.role === "admin";
}
