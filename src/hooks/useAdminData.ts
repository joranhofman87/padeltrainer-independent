import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { getAdminStats, isUserAdmin, type AdminStats } from "@/lib/admin";
import { supabase } from "@/lib/supabaseClient";

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

interface UserDiscount {
  id: string;
  discount_percent: number;
  duration_months: number;
  months_remaining: number;
  source: string;
  is_active: boolean;
  first_payment_at: string | null;
}

interface UserWithRole {
  user_id: string;
  email: string | null;
  full_name: string | null;
  avatar_url: string | null;
  created_at: string;
  role: string | null;
  discount: UserDiscount | null;
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

      // Get all active discounts
      const { data: discounts, error: discountsError } = await supabase
        .from("user_discounts")
        .select("id, user_id, discount_percent, duration_months, months_remaining, source, is_active, first_payment_at");

      if (discountsError) throw discountsError;

      // Merge profiles with roles and discounts
      const rolesMap = new Map(roles?.map((r) => [r.user_id, r.role]) || []);
      const discountsMap = new Map(
        (discounts || []).map((d) => [d.user_id, d])
      );
      return (profiles || []).map((p) => ({
        ...p,
        role: rolesMap.get(p.user_id) || null,
        discount: discountsMap.get(p.user_id) || null,
      }));
    },
    enabled: isAdmin === true,
    staleTime: STALE_TIME,
    gcTime: GC_TIME,
  });
}

export interface TrainerProfileAdmin {
  id: string;
  slug: string | null;
  user_id: string;
  subscription_status: string | null;
  trial_ends_at: string | null;
  trial_started_at: string | null;
  is_public: boolean;
  is_verified: boolean | null;
  created_at: string;
  // Profile fields
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  phone: string | null;
  bio: string | null;
  // Rating fields
  skill_rating: number | null;
  rating_system: string | null;
  rating_member_id: string | null;
  // Trainer specific fields
  hourly_rate: number | null;
  coaching_since_year: number | null;
  coaching_method: string | null;
  favourite_quote: string | null;
  video_url: string | null;
  website_url: string | null;
  social_instagram: string | null;
  social_tiktok: string | null;
  social_youtube: string | null;
  social_linkedin: string | null;
  business_name: string | null;
  business_address: string | null;
  kvk_number: string | null;
  btw_number: string | null;
  iban: string | null;
  // Legacy profile object for backward compatibility
  profile: {
    full_name: string | null;
    email: string | null;
    avatar_url: string | null;
  } | null;
}

export function useAdminTrainers() {
  const { data: isAdmin } = useIsAdmin();

  return useQuery({
    queryKey: ["admin", "trainers"],
    queryFn: async (): Promise<TrainerProfileAdmin[]> => {
      // Fetch trainer profiles with all fields
      const { data: trainers, error: trainersError } = await supabase
        .from("trainer_profiles")
        .select(`
          id, user_id, slug, subscription_status, trial_ends_at, trial_started_at, 
          is_public, is_verified, created_at,
          hourly_rate, coaching_since_year, coaching_method, favourite_quote,
          video_url, website_url, social_instagram, social_tiktok, 
          social_youtube, social_linkedin, business_name, business_address,
          kvk_number, btw_number, iban
        `)
        .order("created_at", { ascending: false });

      if (trainersError) throw trainersError;
      if (!trainers || trainers.length === 0) return [];

      // Fetch profiles for these trainers
      const userIds = trainers.map((t) => t.user_id);
      const { data: profiles, error: profilesError } = await supabase
        .from("profiles")
        .select("user_id, full_name, email, avatar_url, phone, bio, skill_rating, rating_system, rating_member_id")
        .in("user_id", userIds);

      if (profilesError) throw profilesError;

      // Create lookup map for profiles
      const profilesMap = new Map(
        (profiles || []).map((p) => [p.user_id, p])
      );

      // Merge trainers with profiles
      return trainers.map((t) => {
        const profile = profilesMap.get(t.user_id);
        return {
          ...t,
          full_name: profile?.full_name || null,
          email: profile?.email || null,
          avatar_url: profile?.avatar_url || null,
          phone: profile?.phone || null,
          bio: profile?.bio || null,
          skill_rating: profile?.skill_rating || null,
          rating_system: profile?.rating_system || null,
          rating_member_id: profile?.rating_member_id || null,
          // Legacy profile object
          profile: profile ? {
            full_name: profile.full_name,
            email: profile.email,
            avatar_url: profile.avatar_url,
          } : null,
        };
      });
    },
    enabled: isAdmin === true,
    staleTime: STALE_TIME,
    gcTime: GC_TIME,
  });
}

interface AcademyProfileRow {
  id: string;
  name: string;
  slug: string;
  is_verified: boolean;
  is_public: boolean;
  subscription_status: string | null;
  subscription_tier: string | null;
  trial_ends_at: string | null;
  created_at: string;
  contact_email: string | null;
  phone: string | null;
  website_url: string | null;
  logo_url: string | null;
  banner_url: string | null;
  description: string | null;
  social_instagram: string | null;
  social_facebook: string | null;
  social_tiktok: string | null;
  social_youtube: string | null;
  social_linkedin: string | null;
  managers: { user_id: string; role: string }[];
}

export interface AcademyProfileAdmin {
  id: string;
  name: string;
  slug: string;
  is_verified: boolean;
  is_public: boolean;
  subscription_status: string | null;
  subscription_tier: string | null;
  trial_ends_at: string | null;
  created_at: string;
  contact_email: string | null;
  phone: string | null;
  website_url: string | null;
  logo_url: string | null;
  banner_url: string | null;
  description: string | null;
  social_instagram: string | null;
  social_facebook: string | null;
  social_tiktok: string | null;
  social_youtube: string | null;
  social_linkedin: string | null;
  owner_user_id: string | null;
}

export function useAdminAcademies() {
  const { data: isAdmin } = useIsAdmin();

  return useQuery({
    queryKey: ["admin", "academies"],
    queryFn: async (): Promise<AcademyProfileAdmin[]> => {
      const { data, error } = await supabase
        .from("academy_profiles")
        .select(
          `
          id,
          name,
          slug,
          is_verified,
          is_public,
          subscription_status,
          subscription_tier,
          trial_ends_at,
          created_at,
          contact_email,
          phone,
          website_url,
          logo_url,
          banner_url,
          description,
          social_instagram,
          social_facebook,
          social_tiktok,
          social_youtube,
          social_linkedin,
          managers:academy_managers(user_id, role)
        `
        )
        .order("created_at", { ascending: false });

      if (error) throw error;
      
      // Transform managers array to get owner user_id
      return (data as AcademyProfileRow[] || []).map((a) => {
        const owner = a.managers?.find((m) => m.role === "owner") || a.managers?.[0];
        return {
          ...a,
          managers: undefined,
          owner_user_id: owner?.user_id || null,
        };
      });
    },
    enabled: isAdmin === true,
    staleTime: STALE_TIME,
    gcTime: GC_TIME,
    placeholderData: (previousData) => previousData,
  });
}

interface ClubProfileRow {
  id: string;
  is_verified: boolean;
  subscription_status: string | null;
  subscription_tier: string | null;
  trial_ends_at: string | null;
  created_at: string;
  description: string | null;
  contact_email: string | null;
  phone: string | null;
  logo_url: string | null;
  banner_url: string | null;
  social_instagram: string | null;
  social_facebook: string | null;
  social_tiktok: string | null;
  social_youtube: string | null;
  social_linkedin: string | null;
  location: {
    name: string;
    city: string;
    country: string;
    slug: string;
  } | null;
  managers: { user_id: string; role: string }[];
}

export interface ClubProfileAdmin {
  id: string;
  is_verified: boolean;
  subscription_status: string | null;
  subscription_tier: string | null;
  trial_ends_at: string | null;
  created_at: string;
  description: string | null;
  contact_email: string | null;
  phone: string | null;
  logo_url: string | null;
  banner_url: string | null;
  social_instagram: string | null;
  social_facebook: string | null;
  social_tiktok: string | null;
  social_youtube: string | null;
  social_linkedin: string | null;
  location: {
    name: string;
    city: string;
    country: string;
    slug: string;
  } | null;
  owner_user_id: string | null;
}

export function useAdminClubs() {
  const { data: isAdmin } = useIsAdmin();

  return useQuery({
    queryKey: ["admin", "clubs"],
    queryFn: async (): Promise<ClubProfileAdmin[]> => {
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
          description,
          contact_email,
          phone,
          logo_url,
          banner_url,
          social_instagram,
          social_facebook,
          social_tiktok,
          social_youtube,
          social_linkedin,
          location:locations!club_profiles_location_id_fkey(name, city, country, slug),
          managers:club_managers(user_id, role)
        `
        )
        .order("created_at", { ascending: false });

      if (error) throw error;
      
      // Transform managers array to get owner user_id
      return (data as ClubProfileRow[] || []).map((c) => {
        const owner = c.managers?.find((m) => m.role === "owner") || c.managers?.[0];
        return {
          ...c,
          managers: undefined,
          owner_user_id: owner?.user_id || null,
        };
      });
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
    invalidateTrainers: () =>
      queryClient.invalidateQueries({ queryKey: ["admin", "trainers"] }),
    invalidateAcademies: () =>
      queryClient.invalidateQueries({ queryKey: ["admin", "academies"] }),
    invalidatePendingClaims: () =>
      queryClient.invalidateQueries({ queryKey: ["admin", "pendingClaims"] }),
    invalidateAll: () =>
      queryClient.invalidateQueries({ queryKey: ["admin"] }),
  };
}
