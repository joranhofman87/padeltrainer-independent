import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface SubscriptionPlan {
  id: string;
  tier: string;
  name: string;
  description: string | null;
  monthly_price: number;
  yearly_price: number;
  platform_fee_percent: number;
  stripe_price_id_monthly: string | null;
  stripe_price_id_yearly: string | null;
  stripe_product_id_monthly: string | null;
  stripe_product_id_yearly: string | null;
  max_lessons: number | null;
  features: string[];
  is_active: boolean;
  display_order: number;
  is_highlighted: boolean;
  badge: string | null;
  plan_type: "trainer" | "club";
  created_at: string;
  updated_at: string;
}

export function usePricingPlans() {
  return useQuery({
    queryKey: ["pricing-plans"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("subscription_plans")
        .select("*")
        .eq("is_active", true)
        .order("display_order");

      if (error) throw error;
      return data as SubscriptionPlan[];
    },
    staleTime: 1000 * 60 * 5, // 5 minutes cache - pricing rarely changes
  });
}

export function useTrainerPlans() {
  const { data: plans, ...rest } = usePricingPlans();
  
  return {
    data: plans?.filter((p) => p.plan_type === "trainer"),
    ...rest,
  };
}

export function useClubPlan() {
  const { data: plans, ...rest } = usePricingPlans();
  
  return {
    data: plans?.find((p) => p.plan_type === "club"),
    ...rest,
  };
}

export function useAllPricingPlans() {
  return useQuery({
    queryKey: ["pricing-plans", "all"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("subscription_plans")
        .select("*")
        .order("plan_type")
        .order("display_order");

      if (error) throw error;
      return data as SubscriptionPlan[];
    },
    staleTime: 1000 * 60 * 2, // 2 minutes for admin
  });
}

export function useUpdatePricingPlan() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (plan: Partial<SubscriptionPlan> & { id: string }) => {
      const { id, ...updates } = plan;
      const { data, error } = await supabase
        .from("subscription_plans")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pricing-plans"] });
    },
  });
}

export function useCreatePricingPlan() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (plan: Omit<SubscriptionPlan, "id" | "created_at" | "updated_at">) => {
      const { data, error } = await supabase
        .from("subscription_plans")
        .insert(plan)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pricing-plans"] });
    },
  });
}

export function useDeletePricingPlan() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("subscription_plans")
        .delete()
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pricing-plans"] });
    },
  });
}
