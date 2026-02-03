import { supabase } from "@/integrations/supabase/client";

export interface AcademySubscriptionInfo {
  isSubscribed: boolean;
  isTrial: boolean;
  tier: "starter" | "academy";
  subscriptionEnd: string | null;
  trialEnd: string | null;
  trialExpired: boolean;
}

export const ACADEMY_SUBSCRIPTION = {
  name: "Academy Plan",
  priceId: "price_academy_monthly", // Update with actual Mollie price ID
  productId: "prod_academy", // Update with actual Mollie product ID
  monthlyPrice: 199,
  yearlyPrice: 2388,
  trialDays: 14,
} as const;

export async function checkAcademySubscription(academyProfileId: string): Promise<AcademySubscriptionInfo> {
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session) {
    throw new Error("Not authenticated");
  }

  const response = await supabase.functions.invoke("check-mollie-subscription", {
    body: { type: "academy", profileId: academyProfileId },
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

export async function createAcademyCheckout(academyProfileId: string): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session) {
    throw new Error("Not authenticated");
  }

  // Use the same pattern as clubs - create a checkout for academy
  const response = await supabase.functions.invoke("create-academy-mollie-subscription", {
    body: { academyProfileId },
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  if (response.error) {
    throw new Error(response.error.message || "Failed to create checkout");
  }

  return response.data.checkoutUrl;
}

export async function cancelAcademySubscription(academyProfileId: string): Promise<{ success: boolean; message: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session) {
    throw new Error("Not authenticated");
  }

  const response = await supabase.functions.invoke("cancel-mollie-subscription", {
    body: { type: "academy", profileId: academyProfileId },
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  if (response.error) {
    throw new Error(response.error.message || "Failed to cancel subscription");
  }

  return response.data;
}

export function getTrialDaysRemaining(trialEnd: string | null): number {
  if (!trialEnd) return 0;
  const now = new Date();
  const end = new Date(trialEnd);
  const diff = end.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}
