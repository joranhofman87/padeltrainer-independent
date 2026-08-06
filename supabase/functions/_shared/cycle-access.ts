import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

export type CycleOwnerRow = {
  owner_type: string;
  owner_id: string;
};

export async function isAdminUser(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  return !!data;
}

export async function canManageCycle(
  supabase: SupabaseClient,
  userId: string,
  cycle: CycleOwnerRow,
): Promise<boolean> {
  if (cycle.owner_type === "trainer") {
    const { data } = await supabase
      .from("trainer_profiles")
      .select("id")
      .eq("user_id", userId)
      .eq("id", cycle.owner_id)
      .maybeSingle();
    return !!data;
  }

  if (cycle.owner_type === "academy") {
    const { data } = await supabase
      .from("academy_managers")
      .select("id")
      .eq("user_id", userId)
      .eq("academy_profile_id", cycle.owner_id)
      .maybeSingle();
    return !!data;
  }

  if (cycle.owner_type === "club") {
    const { data } = await supabase
      .from("club_managers")
      .select("id")
      .eq("user_id", userId)
      .eq("club_profile_id", cycle.owner_id)
      .maybeSingle();
    return !!data;
  }

  return false;
}
