import { supabase } from "@/integrations/supabase/client";

export interface ClubSubscriptionInfo {
  isSubscribed: boolean;
  isTrial: boolean;
  tier: "starter" | "club";
  subscriptionEnd: string | null;
  trialEnd: string | null;
  trialExpired: boolean;
}

export const CLUB_SUBSCRIPTION = {
  name: "Club Plan",
  priceId: "price_1SqSZBPxAlHS6UZHJHw1xUFB",
  productId: "prod_TobiJfC96Jjf3h",
  monthlyPrice: 199,
  yearlyPrice: 2388,
  trialDays: 14,
} as const;

export async function checkClubSubscription(clubProfileId: string): Promise<ClubSubscriptionInfo> {
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session) {
    throw new Error("Not authenticated");
  }

  const response = await supabase.functions.invoke("check-club-subscription", {
    body: { clubProfileId },
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  if (response.error) {
    throw new Error(response.error.message || "Failed to check subscription");
  }

  return response.data as ClubSubscriptionInfo;
}

export async function createClubCheckout(clubProfileId: string): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session) {
    throw new Error("Not authenticated");
  }

  const response = await supabase.functions.invoke("create-club-checkout", {
    body: { clubProfileId },
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  if (response.error) {
    throw new Error(response.error.message || "Failed to create checkout");
  }

  return response.data.url;
}

export async function openClubBillingPortal(clubProfileId: string): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session) {
    throw new Error("Not authenticated");
  }

  const response = await supabase.functions.invoke("club-customer-portal", {
    body: { clubProfileId },
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  if (response.error) {
    throw new Error(response.error.message || "Failed to open billing portal");
  }

  return response.data.url;
}

export function getTrialDaysRemaining(trialEnd: string | null): number {
  if (!trialEnd) return 0;
  const now = new Date();
  const end = new Date(trialEnd);
  const diff = end.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}
