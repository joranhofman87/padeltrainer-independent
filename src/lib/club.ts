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
    .select('*')
    .eq('club_profile_id', clubProfileId);

  if (error) {
    console.error('Error fetching club managers:', error);
    return [];
  }

  // Fetch profiles separately
  const managersWithProfiles = await Promise.all(
    (data || []).map(async (manager) => {
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, email, avatar_url')
        .eq('user_id', manager.user_id)
        .maybeSingle();
      return { ...manager, profile };
    })
  );

  return managersWithProfiles;
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
    console.error('Error fetching pending claims:', error);
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
    console.error('Error verifying club claim:', error);
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
    console.error('Error rejecting club claim:', error);
    return false;
  }

  return true;
}

// Get club trainers with their slots for calendar view
export async function getClubTrainerSlots(clubProfileId: string, startDate: Date, endDate: Date) {
  const trainers = await getClubTrainers(clubProfileId);
  if (trainers.length === 0) return [];

  const trainerIds = trainers.map((t: any) => t.trainer_profiles.id);

  const { data: slots, error } = await supabase
    .from('availability_slots')
    .select(`
      id,
      trainer_id,
      start_time,
      end_time,
      lesson_id,
      is_marked_full,
      lessons:lesson_id(title, max_participants),
      trainer:trainer_profiles!inner(
        id,
        user_id,
        profiles:profiles!trainer_profiles_user_id_fkey(full_name, avatar_url)
      )
    `)
    .in('trainer_id', trainerIds)
    .gte('start_time', startDate.toISOString())
    .lte('start_time', endDate.toISOString())
    .order('start_time');

  if (error) {
    console.error('Error fetching club trainer slots:', error);
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

  return (slots || []).map((slot: any) => ({
    ...slot,
    active_bookings: bookingCounts[slot.id]?.confirmed || 0,
    pending_bookings: bookingCounts[slot.id]?.pending || 0,
    trainer_name: slot.trainer?.profiles?.full_name || 'Unknown Trainer',
    trainer_avatar: slot.trainer?.profiles?.avatar_url || null,
  }));
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
    console.error('Error creating invitation:', result.error);
    return { success: false, error: result.error.message };
  }

  return { success: true, error: null, invitation: result.data };
}

// Get all invitations for a club
export async function getClubTrainerInvitations(clubProfileId: string) {
  const { data, error } = await supabase
    .from('club_trainer_invitations')
    .select('*')
    .eq('club_profile_id', clubProfileId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching invitations:', error);
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
    console.error('Error fetching invitation by token:', error);
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
    console.error('Error updating invitation:', updateError);
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
    console.error('Error cancelling invitation:', error);
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
    console.error('Error fetching pending invitations:', error);
    return [];
  }

  return data || [];
}
