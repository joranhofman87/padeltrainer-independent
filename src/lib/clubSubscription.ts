import { supabase } from "@/lib/supabaseClient";

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
  monthlyPrice: 199,
  yearlyPrice: 2388,
  trialDays: 14,
} as const;

export async function checkClubSubscription(clubProfileId: string): Promise<ClubSubscriptionInfo> {
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session) {
    throw new Error("Not authenticated");
  }

  const response = await supabase.functions.invoke("check-stripe-subscription", {
    body: { type: "club", profileId: clubProfileId },
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  if (response.error) {
    throw new Error(response.error.message || "Failed to check subscription");
  }

  return {
    isSubscribed: response.data.subscribed,
    isTrial: response.data.status === "trialing",
    tier: response.data.tier || "starter",
    subscriptionEnd: response.data.endsAt || null,
    trialEnd: response.data.trialEndsAt || null,
    trialExpired: response.data.status === "inactive" && !response.data.subscribed,
  };
}

export async function createClubCheckout(clubProfileId: string): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session) {
    throw new Error("Not authenticated");
  }

  const response = await supabase.functions.invoke("create-club-mollie-subscription", {
    body: { clubProfileId },
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  if (response.error) {
    throw new Error(response.error.message || "Failed to create checkout");
  }

  return response.data.checkoutUrl;
}

export async function cancelClubSubscription(clubProfileId: string): Promise<{ success: boolean; message: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session) {
    throw new Error("Not authenticated");
  }

  const response = await supabase.functions.invoke("cancel-mollie-subscription", {
    body: { type: "club", profileId: clubProfileId },
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  if (response.error) {
    throw new Error(response.error.message || "Failed to cancel subscription");
  }

  return response.data;
}

// Re-export shared utility
export { getTrialDaysRemaining } from './sharedSubscription';
