import { supabase } from '@/integrations/supabase/client';

export interface ClubProfile {
  id: string;
  location_id: string;
  description: string | null;
  contact_email: string | null;
  phone: string | null;
  logo_url: string | null;
  is_verified: boolean;
  claimed_at: string;
  created_at: string;
  updated_at: string;
}

export interface ClubManager {
  id: string;
  club_profile_id: string;
  user_id: string;
  role: 'owner' | 'manager';
  invited_by: string | null;
  created_at: string;
}

export interface ClubPlayer {
  id: string;
  club_profile_id: string;
  full_name: string;
  email: string;
  phone: string | null;
  skill_rating: number | null;
  rating_system: string;
  notes: string | null;
  linked_profile_id: string | null;
  created_at: string;
  updated_at: string;
}

// Check if a location has been claimed
export async function isLocationClaimed(locationId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('club_profiles')
    .select('id')
    .eq('location_id', locationId)
    .maybeSingle();

  if (error) {
    console.error('Error checking location claim:', error);
    return false;
  }

  return !!data;
}

// Get club profile by location ID
export async function getClubProfileByLocation(locationId: string): Promise<ClubProfile | null> {
  const { data, error } = await supabase
    .from('club_profiles')
    .select('*')
    .eq('location_id', locationId)
    .maybeSingle();

  if (error) {
    console.error('Error fetching club profile:', error);
    return null;
  }

  return data;
}

// Create a club claim (creates club_profile and club_manager)
export async function claimClub(
  locationId: string,
  userId: string,
  contactEmail: string,
  phone?: string,
  description?: string
): Promise<{ clubProfile: ClubProfile; error: Error | null }> {
  // First, create the club profile
  const { data: clubProfile, error: profileError } = await supabase
    .from('club_profiles')
    .insert({
      location_id: locationId,
      contact_email: contactEmail,
      phone: phone || null,
      description: description || null,
      is_verified: false,
    })
    .select()
    .single();

  if (profileError) {
    console.error('Error creating club profile:', profileError);
    return { clubProfile: null as any, error: profileError };
  }

  // Then, add the user as the owner
  const { error: managerError } = await supabase
    .from('club_managers')
    .insert({
      club_profile_id: clubProfile.id,
      user_id: userId,
      role: 'owner',
    });

  if (managerError) {
    console.error('Error creating club manager:', managerError);
    // Clean up the club profile if manager creation fails
    await supabase.from('club_profiles').delete().eq('id', clubProfile.id);
    return { clubProfile: null as any, error: managerError };
  }

  return { clubProfile, error: null };
}

// Get user's club profiles (clubs they manage)
export async function getUserClubProfiles(userId: string): Promise<(ClubProfile & { role: string; location: any })[]> {
  const { data, error } = await supabase
    .from('club_managers')
    .select(`
      role,
      club_profile:club_profiles(
        *,
        location:locations(*)
      )
    `)
    .eq('user_id', userId);

  if (error) {
    console.error('Error fetching user club profiles:', error);
    return [];
  }

  return data?.map((item: any) => ({
    ...item.club_profile,
    role: item.role,
    location: item.club_profile.location,
  })) || [];
}

// Check if user is a club manager
export async function isUserClubManager(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('club_managers')
    .select('id')
    .eq('user_id', userId)
    .limit(1);

  if (error) {
    console.error('Error checking club manager status:', error);
    return false;
  }

  return (data?.length || 0) > 0;
}

// Get club's trainers (only club_trainers, not independent)
export async function getClubTrainers(clubProfileId: string) {
  // First get the location_id for this club
  const { data: clubProfile, error: clubError } = await supabase
    .from('club_profiles')
    .select('location_id')
    .eq('id', clubProfileId)
    .single();

  if (clubError || !clubProfile) {
    console.error('Error fetching club profile:', clubError);
    return [];
  }

  // Then get trainers at this location who are club_trainers
  const { data, error } = await supabase
    .from('trainer_locations')
    .select(`
      id,
      is_primary,
      relationship_type,
      trainer_id,
      trainer_profiles!inner (
        id,
        user_id,
        hourly_rate,
        experience_years,
        specializations,
        certifications,
        is_verified
      )
    `)
    .eq('location_id', clubProfile.location_id)
    .eq('relationship_type', 'club_trainer');

  if (error) {
    console.error('Error fetching club trainers:', error);
    return [];
  }

  return data || [];
}

// Get club players
export async function getClubPlayers(clubProfileId: string): Promise<ClubPlayer[]> {
  const { data, error } = await supabase
    .from('club_players')
    .select('*')
    .eq('club_profile_id', clubProfileId)
    .order('full_name');

  if (error) {
    console.error('Error fetching club players:', error);
    return [];
  }

  return data || [];
}

// Add a player to the club
export async function addClubPlayer(
  clubProfileId: string,
  player: Omit<ClubPlayer, 'id' | 'club_profile_id' | 'created_at' | 'updated_at'>
): Promise<ClubPlayer | null> {
  const { data, error } = await supabase
    .from('club_players')
    .insert({
      club_profile_id: clubProfileId,
      ...player,
    })
    .select()
    .single();

  if (error) {
    console.error('Error adding club player:', error);
    return null;
  }

  return data;
}

// Update a club player
export async function updateClubPlayer(
  playerId: string,
  updates: Partial<ClubPlayer>
): Promise<ClubPlayer | null> {
  const { data, error } = await supabase
    .from('club_players')
    .update(updates)
    .eq('id', playerId)
    .select()
    .single();

  if (error) {
    console.error('Error updating club player:', error);
    return null;
  }

  return data;
}

// Delete a club player
export async function deleteClubPlayer(playerId: string): Promise<boolean> {
  const { error } = await supabase
    .from('club_players')
    .delete()
    .eq('id', playerId);

  if (error) {
    console.error('Error deleting club player:', error);
    return false;
  }

  return true;
}

// Update club profile
export async function updateClubProfile(
  clubProfileId: string,
  updates: Partial<ClubProfile>
): Promise<ClubProfile | null> {
  const { data, error } = await supabase
    .from('club_profiles')
    .update(updates)
    .eq('id', clubProfileId)
    .select()
    .single();

  if (error) {
    console.error('Error updating club profile:', error);
    return null;
  }

  return data;
}

// Get club managers
export async function getClubManagers(clubProfileId: string) {
  const { data, error } = await supabase
    .from('club_managers')
    .select(`
      *,
      profile:profiles!club_managers_user_id_fkey(
        full_name,
        email,
        avatar_url
      )
    `)
    .eq('club_profile_id', clubProfileId);

  if (error) {
    console.error('Error fetching club managers:', error);
    return [];
  }

  return data || [];
}

// Invite a manager to the club
export async function inviteClubManager(
  clubProfileId: string,
  userEmail: string,
  invitedBy: string
): Promise<{ success: boolean; error: string | null }> {
  // Find user by email
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('user_id')
    .eq('email', userEmail)
    .maybeSingle();

  if (profileError || !profile) {
    return { success: false, error: 'User not found with that email' };
  }

  // Add as manager
  const { error } = await supabase
    .from('club_managers')
    .insert({
      club_profile_id: clubProfileId,
      user_id: profile.user_id,
      role: 'manager',
      invited_by: invitedBy,
    });

  if (error) {
    if (error.code === '23505') {
      return { success: false, error: 'User is already a manager of this club' };
    }
    return { success: false, error: error.message };
  }

  return { success: true, error: null };
}

// Remove a manager from the club
export async function removeClubManager(managerId: string): Promise<boolean> {
  const { error } = await supabase
    .from('club_managers')
    .delete()
    .eq('id', managerId);

  if (error) {
    console.error('Error removing club manager:', error);
    return false;
  }

  return true;
}
