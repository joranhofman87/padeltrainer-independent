import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';

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
    logger.error('Error checking location claim', undefined, { error });
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
    logger.error('Error fetching club profile', undefined, { error });
    return null;
  }

  return data;
}

// Create a club claim (creates club_profile and club_manager)
// Returns success boolean - the profile is pending verification and cannot be read back
export async function claimClub(
  locationId: string,
  userId: string,
  contactEmail: string,
  phone?: string,
  description?: string
): Promise<{ success: boolean; error: Error | null }> {
  // Verify session is active to prevent RLS errors
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    return { 
      success: false, 
      error: new Error('Not authenticated. Please log in and try again.') 
    };
  }

  // Create the club profile with created_by to allow the user to see their pending claim
  const { data: insertResult, error: profileError } = await supabase
    .from('club_profiles')
    .insert({
      location_id: locationId,
      contact_email: contactEmail,
      phone: phone || null,
      description: description || null,
      is_verified: false,
      created_by: session.user.id, // Use session user ID for RLS
    })
    .select('id')
    .single();

  if (profileError) {
    logger.error('Error creating club profile', undefined, { error: profileError });
    const errorMessage = profileError.code === '23505' 
      ? 'This location has already been claimed'
      : `Failed to create club claim: ${profileError.message}`;
    return { success: false, error: new Error(errorMessage) };
  }

  // Add the user as the owner
  const { error: managerError } = await supabase
    .from('club_managers')
    .insert({
      club_profile_id: insertResult.id,
      user_id: session.user.id, // Use session user ID for consistency
      role: 'owner',
    });

  if (managerError) {
    logger.error('Error creating club manager', undefined, { error: managerError });
    // Clean up the club profile if manager creation fails
    await supabase.from('club_profiles').delete().eq('id', insertResult.id);
    const errorMessage = `Failed to assign ownership: ${managerError.message}. Please try again or contact support.`;
    return { success: false, error: new Error(errorMessage) };
  }

  // Also assign the 'club' role to the user if they don't already have it
  const { error: roleError } = await supabase
    .from('user_roles')
    .insert({ user_id: session.user.id, role: 'club' });

  // Ignore duplicate key error (user might already have this role)
  if (roleError && roleError.code !== '23505') {
    logger.warn('Error setting club role', { error: roleError });
  }

  return { success: true, error: null };
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
    logger.error('Error fetching user club profiles', undefined, { error });
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
    logger.error('Error checking club manager status', undefined, { error });
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
    logger.error('Error fetching club profile', undefined, { error: clubError });
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
      show_on_club_page,
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
    logger.error('Error fetching club trainers', undefined, { error });
    return [];
  }

  return data || [];
}

// Update trainer visibility on club page
export async function updateTrainerVisibility(
  trainerLocationId: string,
  showOnClubPage: boolean
): Promise<boolean> {
  const { error } = await supabase
    .from('trainer_locations')
    .update({ show_on_club_page: showOnClubPage })
    .eq('id', trainerLocationId);

  if (error) {
    logger.error('Error updating trainer visibility', undefined, { error });
    return false;
  }

  return true;
}

// Get club players with optional pagination
export async function getClubPlayers(
  clubProfileId: string,
  options: { page?: number; pageSize?: number } = {}
): Promise<ClubPlayer[]> {
  const { page = 0, pageSize = 100 } = options;
  const from = page * pageSize;
  const to = from + pageSize - 1;

  const { data, error } = await supabase
    .from('club_players')
    .select('*')
    .eq('club_profile_id', clubProfileId)
    .order('full_name')
    .range(from, to);

  if (error) {
    logger.error('Error fetching club players', undefined, { error });
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
    logger.error('Error adding club player', undefined, { error });
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
    logger.error('Error updating club player', undefined, { error });
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
    logger.error('Error deleting club player', undefined, { error });
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
    logger.error('Error updating club profile', undefined, { error });
    return null;
  }

  return data;
}

// Get club managers with profiles using optimized batch query
export async function getClubManagers(clubProfileId: string) {
  const { data, error } = await supabase
    .from('club_managers')
    .select('*')
    .eq('club_profile_id', clubProfileId);

  if (error) {
    logger.error('Error fetching club managers', undefined, { error });
    return [];
  }

  if (!data || data.length === 0) return [];

  // Batch fetch all profiles in a single query
  const userIds = data.map((m) => m.user_id);
  const { data: profiles } = await supabase
    .from('profiles')
    .select('user_id, full_name, email, avatar_url')
    .in('user_id', userIds);

  // Create a lookup map for profiles
  const profileMap = new Map(
    (profiles || []).map((p) => [p.user_id, p])
  );

  // Merge profiles with managers
  return data.map((manager) => ({
    ...manager,
    profile: profileMap.get(manager.user_id) || null,
  }));
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
    logger.error('Error removing club manager', undefined, { error });
    return false;
  }

  return true;
}

// Get all pending club claims (for admin)
export async function getPendingClubClaims(): Promise<(ClubProfile & { location: any; owner: any })[]> {
  const { data, error } = await supabase
    .from('club_profiles')
    .select(`
      *,
      location:locations(*),
      managers:club_managers(
        user_id,
        role,
        profile:profiles(full_name, email)
      )
    `)
    .eq('is_verified', false)
    .order('claimed_at', { ascending: false });

  if (error) {
    logger.error('Error fetching pending claims', undefined, { error });
    return [];
  }

  return (data || []).map((claim: any) => ({
    ...claim,
    owner: claim.managers?.find((m: any) => m.role === 'owner')?.profile || null,
  }));
}

// Verify a club claim (admin only)
export async function verifyClubClaim(clubProfileId: string): Promise<boolean> {
  const { error } = await supabase
    .from('club_profiles')
    .update({ is_verified: true })
    .eq('id', clubProfileId);

  if (error) {
    logger.error('Error verifying club claim', undefined, { error });
    return false;
  }

  return true;
}

// Reject a club claim (admin only) - deletes the claim
export async function rejectClubClaim(clubProfileId: string): Promise<boolean> {
  // First delete the managers
  await supabase
    .from('club_managers')
    .delete()
    .eq('club_profile_id', clubProfileId);

  // Then delete the profile
  const { error } = await supabase
    .from('club_profiles')
    .delete()
    .eq('id', clubProfileId);

  if (error) {
    logger.error('Error rejecting club claim', undefined, { error });
    return false;
  }

  return true;
}

// Get club trainers with their slots for calendar view
export async function getClubTrainerSlots(clubProfileId: string, startDate: Date, endDate: Date) {
  // First get the club's location_id to filter slots
  const { data: clubProfile, error: clubError } = await supabase
    .from('club_profiles')
    .select('location_id')
    .eq('id', clubProfileId)
    .single();

  if (clubError || !clubProfile) {
    logger.error('Error fetching club profile for calendar', undefined, { error: clubError });
    return [];
  }

  const trainers = await getClubTrainers(clubProfileId);
  if (trainers.length === 0) return [];

  const trainerIds = trainers.map((t: any) => t.trainer_profiles.id);

  // Build a map of trainer_id to profile info from trainers data
  const trainerProfileMap: Record<string, { user_id: string }> = {};
  trainers.forEach((t: any) => {
    trainerProfileMap[t.trainer_profiles.id] = {
      user_id: t.trainer_profiles.user_id,
    };
  });

  // Fetch all user profiles for trainers
  const userIds = trainers.map((t: any) => t.trainer_profiles.user_id);
  const { data: profiles } = await supabase
    .from('profiles')
    .select('user_id, full_name, avatar_url')
    .in('user_id', userIds);

  const profileMap: Record<string, { full_name: string; avatar_url: string | null }> = {};
  (profiles || []).forEach((p: any) => {
    profileMap[p.user_id] = { full_name: p.full_name, avatar_url: p.avatar_url };
  });

  // Fetch slots - filter by both trainer IDs and the club's location
  const { data: slots, error } = await supabase
    .from('availability_slots')
    .select(`
      id,
      trainer_id,
      start_time,
      end_time,
      is_marked_full,
      max_participants,
      cyclus_name,
      rating_system,
      min_rating,
      max_rating
    `)
    .in('trainer_id', trainerIds)
    .eq('location_id', clubProfile.location_id)
    .gte('start_time', startDate.toISOString())
    .lte('start_time', endDate.toISOString())
    .order('start_time');

  if (error) {
    logger.error('Error fetching club trainer slots', undefined, { error });
    return [];
  }

  // Get bookings for these slots
  const slotIds = slots?.map((s) => s.id) || [];
  let bookings: any[] = [];

  if (slotIds.length > 0) {
    const { data: bookingsData } = await supabase
      .from('bookings')
      .select('slot_id, status')
      .in('slot_id', slotIds);
    bookings = bookingsData || [];
  }

  // Aggregate booking counts
  const bookingCounts: Record<string, { confirmed: number; pending: number }> = {};
  bookings.forEach((b) => {
    if (!bookingCounts[b.slot_id]) {
      bookingCounts[b.slot_id] = { confirmed: 0, pending: 0 };
    }
    if (b.status === 'confirmed') {
      bookingCounts[b.slot_id].confirmed++;
    } else if (b.status === 'pending') {
      bookingCounts[b.slot_id].pending++;
    }
  });

  return (slots || []).map((slot: any) => {
    const trainerInfo = trainerProfileMap[slot.trainer_id];
    const profile = trainerInfo ? profileMap[trainerInfo.user_id] : null;
    return {
      ...slot,
      active_bookings: bookingCounts[slot.id]?.confirmed || 0,
      pending_bookings: bookingCounts[slot.id]?.pending || 0,
      trainer_name: profile?.full_name || 'Unknown Trainer',
      trainer_avatar: profile?.avatar_url || null,
    };
  });
}

// ============= Trainer Invitation System =============

export interface ClubTrainerInvitation {
  id: string;
  club_profile_id: string;
  trainer_email: string;
  trainer_profile_id: string | null;
  invited_by: string;
  status: 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled';
  token: string;
  message: string | null;
  created_at: string;
  responded_at: string | null;
}

// Send invitation to a trainer
export async function inviteClubTrainer(
  clubProfileId: string,
  trainerEmail: string,
  invitedBy: string,
  message?: string
): Promise<{ success: boolean; error: string | null; invitation?: ClubTrainerInvitation }> {
  // Check if invitation already exists
  const { data: existing } = await supabase
    .from('club_trainer_invitations')
    .select('*')
    .eq('club_profile_id', clubProfileId)
    .eq('trainer_email', trainerEmail.toLowerCase())
    .single();

  if (existing && existing.status === 'pending') {
    return { success: false, error: 'An invitation is already pending for this email' };
  }

  // Look up if trainer exists by email
  const { data: profile } = await supabase
    .from('profiles')
    .select('user_id')
    .eq('email', trainerEmail.toLowerCase())
    .single();

  let trainerProfileId = null;
  if (profile) {
    const { data: trainerProfile } = await supabase
      .from('trainer_profiles')
      .select('id')
      .eq('user_id', profile.user_id)
      .single();
    trainerProfileId = trainerProfile?.id || null;
  }

  // Create or update invitation
  const invitationData = {
    club_profile_id: clubProfileId,
    trainer_email: trainerEmail.toLowerCase(),
    trainer_profile_id: trainerProfileId,
    invited_by: invitedBy,
    message: message || null,
    status: 'pending',
    responded_at: null,
  };

  let result;
  if (existing) {
    // Update existing cancelled/declined invitation
    result = await supabase
      .from('club_trainer_invitations')
      .update({ ...invitationData, token: crypto.randomUUID() })
      .eq('id', existing.id)
      .select()
      .single();
  } else {
    result = await supabase
      .from('club_trainer_invitations')
      .insert(invitationData)
      .select()
      .single();
  }

  if (result.error) {
    logger.error('Error creating invitation', undefined, { error: result.error });
    return { success: false, error: result.error.message };
  }

  return { success: true, error: null, invitation: result.data };
}

// Get all invitations for a club with optional limit
export async function getClubTrainerInvitations(
  clubProfileId: string,
  limit: number = 100
) {
  const { data, error } = await supabase
    .from('club_trainer_invitations')
    .select('*')
    .eq('club_profile_id', clubProfileId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error('Error fetching invitations', undefined, { error });
    return [];
  }

  return data || [];
}

// Get invitation by token (for response page)
export async function getInvitationByToken(token: string) {
  const { data, error } = await supabase
    .from('club_trainer_invitations')
    .select(`
      *,
      club_profiles!inner(
        id,
        location_id,
        contact_email,
        description,
        locations:location_id(name, city)
      )
    `)
    .eq('token', token)
    .single();

  if (error) {
    logger.error('Error fetching invitation by token', undefined, { error });
    return null;
  }

  // Get inviter name
  const { data: inviterProfile } = await supabase
    .from('profiles')
    .select('full_name')
    .eq('user_id', data.invited_by)
    .single();

  return {
    ...data,
    inviter_name: inviterProfile?.full_name || 'Club Manager',
  };
}

// Respond to invitation (accept/decline)
export async function respondToTrainerInvitation(
  token: string,
  accept: boolean,
  userId: string
): Promise<{ success: boolean; error: string | null }> {
  // Get the invitation
  const invitation = await getInvitationByToken(token);
  if (!invitation) {
    return { success: false, error: 'Invitation not found or expired' };
  }

  if (invitation.status !== 'pending') {
    return { success: false, error: 'This invitation has already been responded to' };
  }

  // Verify user is a trainer
  const { data: trainerProfile } = await supabase
    .from('trainer_profiles')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (!trainerProfile) {
    return { success: false, error: 'You must have a trainer account to accept this invitation' };
  }

  // Update invitation status
  const { error: updateError } = await supabase
    .from('club_trainer_invitations')
    .update({
      status: accept ? 'accepted' : 'declined',
      responded_at: new Date().toISOString(),
      trainer_profile_id: trainerProfile.id,
    })
    .eq('token', token);

  if (updateError) {
    logger.error('Error updating invitation', undefined, { error: updateError });
    return { success: false, error: updateError.message };
  }

  // If accepted, create/update trainer_locations entry
  if (accept) {
    const locationId = invitation.club_profiles?.location_id;
    
    // Check if trainer already has this location
    const { data: existingLocation } = await supabase
      .from('trainer_locations')
      .select('id')
      .eq('trainer_id', trainerProfile.id)
      .eq('location_id', locationId)
      .single();

    if (existingLocation) {
      // Update to club_trainer
      await supabase
        .from('trainer_locations')
        .update({ relationship_type: 'club_trainer' })
        .eq('id', existingLocation.id);
    } else {
      // Create new entry
      await supabase
        .from('trainer_locations')
        .insert({
          trainer_id: trainerProfile.id,
          location_id: locationId,
          relationship_type: 'club_trainer',
          is_primary: false,
        });
    }
  }

  return { success: true, error: null };
}

// Cancel an invitation
export async function cancelTrainerInvitation(invitationId: string): Promise<boolean> {
  const { error } = await supabase
    .from('club_trainer_invitations')
    .update({ status: 'cancelled' })
    .eq('id', invitationId)
    .eq('status', 'pending');

  if (error) {
    logger.error('Error cancelling invitation', undefined, { error });
    return false;
  }

  return true;
}

// Get pending invitations for a trainer (by email)
export async function getPendingTrainerInvitationsForUser(userId: string): Promise<any[]> {
  // Get user's email
  const { data: profile } = await supabase
    .from('profiles')
    .select('email')
    .eq('user_id', userId)
    .single();

  if (!profile?.email) return [];

  const { data, error } = await supabase
    .from('club_trainer_invitations')
    .select(`
      *,
      club_profiles!inner(
        id,
        locations:location_id(name, city)
      )
    `)
    .eq('trainer_email', profile.email.toLowerCase())
    .eq('status', 'pending');

  if (error) {
    logger.error('Error fetching pending invitations', undefined, { error });
    return [];
  }

  return data || [];
}
