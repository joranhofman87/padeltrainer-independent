import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { getAdminStats, isUserAdmin, type AdminStats } from "@/lib/admin";
import { supabase } from "@/integrations/supabase/client";

// Cache times
const STALE_TIME = 1000 * 60 * 2; // 2 minutes - show cached data instantly
const GC_TIME = 1000 * 60 * 10; // 10 minutes - keep in cache

export function useIsAdmin() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["admin", "check", user?.id],
    queryFn: () => isUserAdmin(user!.id),
    enabled: !!user,
    staleTime: 1000 * 60 * 5, // 5 minutes - role rarely changes
    gcTime: GC_TIME,
  });
}

export function useAdminStats() {
  const { data: isAdmin } = useIsAdmin();

  return useQuery({
    queryKey: ["admin", "stats"],
    queryFn: getAdminStats,
    enabled: isAdmin === true,
    staleTime: STALE_TIME,
    gcTime: GC_TIME,
  });
}

export function usePendingClaimsCount() {
  const { data: isAdmin } = useIsAdmin();

  return useQuery({
    queryKey: ["admin", "pendingClaims"],
    queryFn: async () => {
      const { count } = await supabase
        .from("club_profiles")
        .select("id", { count: "exact", head: true })
        .eq("is_verified", false);
      return count || 0;
    },
    enabled: isAdmin === true,
    staleTime: STALE_TIME,
    gcTime: GC_TIME,
  });
}

interface UserWithRole {
  user_id: string;
  email: string | null;
  full_name: string | null;
  avatar_url: string | null;
  created_at: string;
  role: string | null;
}

export function useAdminUsers() {
  const { data: isAdmin } = useIsAdmin();

  return useQuery({
    queryKey: ["admin", "users"],
    queryFn: async (): Promise<UserWithRole[]> => {
      // Get all profiles
      const { data: profiles, error: profilesError } = await supabase
        .from("profiles")
        .select("user_id, email, full_name, avatar_url, created_at")
        .order("created_at", { ascending: false });

      if (profilesError) throw profilesError;

      // Get all user roles
      const { data: roles, error: rolesError } = await supabase
        .from("user_roles")
        .select("user_id, role");

      if (rolesError) throw rolesError;

      // Merge profiles with roles
      const rolesMap = new Map(roles?.map((r) => [r.user_id, r.role]) || []);
      return (profiles || []).map((p) => ({
        ...p,
        role: rolesMap.get(p.user_id) || null,
      }));
    },
    enabled: isAdmin === true,
    staleTime: STALE_TIME,
    gcTime: GC_TIME,
  });
}

interface ClubProfile {
  id: string;
  is_verified: boolean;
  subscription_status: string | null;
  subscription_tier: string | null;
  trial_ends_at: string | null;
  created_at: string;
  location: {
    name: string;
    city: string;
  } | null;
}

export function useAdminClubs() {
  const { data: isAdmin } = useIsAdmin();

  return useQuery({
    queryKey: ["admin", "clubs"],
    queryFn: async (): Promise<ClubProfile[]> => {
      const { data, error } = await supabase
        .from("club_profiles")
        .select(
          `
          id,
          is_verified,
          subscription_status,
          subscription_tier,
          trial_ends_at,
          created_at,
          location:locations!club_profiles_location_id_fkey(name, city)
        `
        )
        .order("created_at", { ascending: false });

      if (error) throw error;
      return data || [];
    },
    enabled: isAdmin === true,
    staleTime: STALE_TIME,
    gcTime: GC_TIME,
  });
}

export function useInvalidateAdminData() {
  const queryClient = useQueryClient();

  return {
    invalidateStats: () =>
      queryClient.invalidateQueries({ queryKey: ["admin", "stats"] }),
    invalidateUsers: () =>
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] }),
    invalidateClubs: () =>
      queryClient.invalidateQueries({ queryKey: ["admin", "clubs"] }),
    invalidatePendingClaims: () =>
      queryClient.invalidateQueries({ queryKey: ["admin", "pendingClaims"] }),
    invalidateAll: () =>
      queryClient.invalidateQueries({ queryKey: ["admin"] }),
  };
}
