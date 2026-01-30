import { supabase } from '@/integrations/supabase/client';

export interface AcademyProfile {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  logo_url: string | null;
  banner_url: string | null;
  contact_email: string | null;
  phone: string | null;
  website_url: string | null;
  social_instagram: string | null;
  social_facebook: string | null;
  social_linkedin: string | null;
  social_youtube: string | null;
  social_tiktok: string | null;
  is_verified: boolean;
  is_public: boolean;
  subscription_status: string | null;
  subscription_tier: string | null;
  trial_ends_at: string | null;
  subscription_ends_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AcademyManager {
  id: string;
  academy_profile_id: string;
  user_id: string;
  role: 'owner' | 'manager';
  invited_by: string | null;
  created_at: string;
}

export interface AcademyTrainer {
  id: string;
  academy_profile_id: string;
  trainer_profile_id: string;
  status: 'active' | 'invited' | 'inactive';
  payment_percentage: number;
  show_on_academy_page: boolean;
  invited_by: string | null;
  joined_at: string | null;
  created_at: string;
}

export interface AcademyLocation {
  id: string;
  academy_profile_id: string;
  location_id: string;
  contract_type: 'exclusive' | 'non_exclusive';
  contract_start: string | null;
  contract_end: string | null;
  is_active: boolean;
  show_on_academy_page: boolean;
  show_on_club_page: boolean;
  created_at: string;
}

// Generate a URL-friendly slug from academy name
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
    .replace(/[^a-z0-9\s-]/g, '') // Remove special chars
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Remove consecutive hyphens
    .trim();
}

// Check if a slug is already taken
async function isSlugTaken(slug: string): Promise<boolean> {
  const { data } = await supabase
    .from('academy_profiles')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();
  return !!data;
}

// Generate a unique slug
async function generateUniqueSlug(name: string): Promise<string> {
  let baseSlug = generateSlug(name);
  let slug = baseSlug;
  let counter = 1;
  
  while (await isSlugTaken(slug)) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }
  
  return slug;
}

// Create a new academy
export async function createAcademy(
  name: string,
  userId: string,
  contactEmail?: string,
  description?: string
): Promise<{ success: boolean; academyId?: string; error: Error | null }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    return { 
      success: false, 
      error: new Error('Not authenticated. Please log in and try again.') 
    };
  }

  try {
    const slug = await generateUniqueSlug(name);

    // Create the academy profile
    const { data: academy, error: profileError } = await supabase
      .from('academy_profiles')
      .insert({
        name,
        slug,
        description: description || null,
        contact_email: contactEmail || null,
        is_verified: false,
        is_public: false,
        created_by: session.user.id,
      })
      .select('id')
      .single();

    if (profileError) {
      console.error('Error creating academy profile:', profileError);
      return { success: false, error: new Error(profileError.message) };
    }

    // Add the user as the owner
    const { error: managerError } = await supabase
      .from('academy_managers')
      .insert({
        academy_profile_id: academy.id,
        user_id: session.user.id,
        role: 'owner',
      });

    if (managerError) {
      console.error('Error creating academy manager:', managerError);
      // Clean up the academy profile if manager creation fails
      await supabase.from('academy_profiles').delete().eq('id', academy.id);
      return { success: false, error: new Error(managerError.message) };
    }

    // Assign the 'academy' role to the user if they don't already have it
    const { error: roleError } = await supabase
      .from('user_roles')
      .insert({ user_id: session.user.id, role: 'academy' });

    // Ignore duplicate key error
    if (roleError && roleError.code !== '23505') {
      console.error('Error setting academy role:', roleError);
    }

    return { success: true, academyId: academy.id, error: null };
  } catch (err) {
    console.error('Error creating academy:', err);
    return { success: false, error: err as Error };
  }
}

// Get user's academy profiles
export async function getUserAcademyProfiles(userId: string): Promise<(AcademyProfile & { role: string })[]> {
  const { data, error } = await supabase
    .from('academy_managers')
    .select(`
      role,
      academy_profile:academy_profiles(*)
    `)
    .eq('user_id', userId);

  if (error) {
    console.error('Error fetching user academy profiles:', error);
    return [];
  }

  return data?.map((item: any) => ({
    ...item.academy_profile,
    role: item.role,
  })) || [];
}

// Check if user is an academy manager
export async function isUserAcademyManager(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('academy_managers')
    .select('id')
    .eq('user_id', userId)
    .limit(1);

  if (error) {
    console.error('Error checking academy manager status:', error);
    return false;
  }

  return (data?.length || 0) > 0;
}

// Get academy by slug (for public profile)
export async function getAcademyBySlug(slug: string): Promise<Partial<AcademyProfile> | null> {
  const { data, error } = await supabase
    .from('academy_profiles_public')
    .select('*')
    .eq('slug', slug)
    .eq('is_verified', true)
    .eq('is_public', true)
    .maybeSingle();

  if (error) {
    console.error('Error fetching academy by slug:', error);
    return null;
  }

  return data;
}

// Get academy by ID
export async function getAcademyById(id: string): Promise<AcademyProfile | null> {
  const { data, error } = await supabase
    .from('academy_profiles')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error('Error fetching academy by id:', error);
    return null;
  }

  return data;
}

// Update academy profile
export async function updateAcademyProfile(
  academyId: string,
  updates: Partial<AcademyProfile>
): Promise<AcademyProfile | null> {
  const { data, error } = await supabase
    .from('academy_profiles')
    .update(updates)
    .eq('id', academyId)
    .select()
    .single();

  if (error) {
    console.error('Error updating academy profile:', error);
    return null;
  }

  return data;
}

// Get academy trainers
export async function getAcademyTrainers(academyProfileId: string): Promise<any[]> {
  const { data, error } = await supabase
    .from('academy_trainers')
    .select(`
      *,
      trainer_profile:trainer_profiles(
        id,
        user_id,
        hourly_rate,
        experience_years,
        specializations,
        certifications,
        is_verified
      )
    `)
    .eq('academy_profile_id', academyProfileId)
    .eq('status', 'active');

  if (error) {
    console.error('Error fetching academy trainers:', error);
    return [];
  }

  return data || [];
}

// Get academy locations
export async function getAcademyLocations(academyProfileId: string): Promise<any[]> {
  const { data, error } = await supabase
    .from('academy_locations')
    .select(`
      *,
      location:locations(*)
    `)
    .eq('academy_profile_id', academyProfileId)
    .eq('is_active', true);

  if (error) {
    console.error('Error fetching academy locations:', error);
    return [];
  }

  return data || [];
}

// Get trainer's academy affiliation (for trainer profile display)
export async function getTrainerAcademy(trainerProfileId: string): Promise<Partial<AcademyProfile> | null> {
  const { data, error } = await supabase
    .from('academy_trainers')
    .select(`
      academy_profile:academy_profiles_public(*)
    `)
    .eq('trainer_profile_id', trainerProfileId)
    .eq('status', 'active')
    .maybeSingle();

  if (error) {
    console.error('Error fetching trainer academy:', error);
    return null;
  }

  return data?.academy_profile || null;
}

// Get academies at a location (for club/location page display)
export async function getAcademiesAtLocation(locationId: string): Promise<Partial<AcademyProfile>[]> {
  const { data, error } = await supabase
    .from('academy_locations')
    .select(`
      academy_profile:academy_profiles_public(*)
    `)
    .eq('location_id', locationId)
    .eq('is_active', true)
    .eq('show_on_club_page', true);

  if (error) {
    console.error('Error fetching academies at location:', error);
    return [];
  }

  return data?.map((item: any) => item.academy_profile).filter(Boolean) || [];
}

// Get academy managers
export async function getAcademyManagers(academyProfileId: string): Promise<any[]> {
  const { data, error } = await supabase
    .from('academy_managers')
    .select('*')
    .eq('academy_profile_id', academyProfileId);

  if (error) {
    console.error('Error fetching academy managers:', error);
    return [];
  }

  if (!data || data.length === 0) return [];

  // Batch fetch all profiles
  const userIds = data.map((m) => m.user_id);
  const { data: profiles } = await supabase
    .from('profiles')
    .select('user_id, full_name, email, avatar_url')
    .in('user_id', userIds);

  const profileMap = new Map(
    (profiles || []).map((p) => [p.user_id, p])
  );

  return data.map((manager) => ({
    ...manager,
    profile: profileMap.get(manager.user_id) || null,
  }));
}

// Get academy view stats
export async function getAcademyViewStats(academyProfileId: string): Promise<{ last7Days: number; last30Days: number }> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [last7Response, last30Response] = await Promise.all([
    supabase
      .from('academy_profile_views')
      .select('id', { count: 'exact', head: true })
      .eq('academy_profile_id', academyProfileId)
      .gte('viewed_at', sevenDaysAgo),
    supabase
      .from('academy_profile_views')
      .select('id', { count: 'exact', head: true })
      .eq('academy_profile_id', academyProfileId)
      .gte('viewed_at', thirtyDaysAgo),
  ]);

  return {
    last7Days: last7Response.count || 0,
    last30Days: last30Response.count || 0,
  };
}

// Record academy profile view
export async function recordAcademyProfileView(academyProfileId: string, sessionId?: string): Promise<void> {
  await supabase.from('academy_profile_views').insert({
    academy_profile_id: academyProfileId,
    session_id: sessionId || null,
  });
}

// ===================== Location Contract Functions =====================

export interface AcademyLocationWithDetails extends AcademyLocation {
  location: {
    id: string;
    name: string;
    city: string;
    street_address: string | null;
    logo_url: string | null;
    slug: string;
  };
}

// Get all locations for an academy
export async function getAcademyLocationsWithDetails(academyProfileId: string): Promise<AcademyLocationWithDetails[]> {
  const { data, error } = await supabase
    .from('academy_locations')
    .select(`
      *,
      location:locations(id, name, city, street_address, logo_url, slug)
    `)
    .eq('academy_profile_id', academyProfileId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching academy locations:', error);
    return [];
  }

  return (data || []) as AcademyLocationWithDetails[];
}

// Add a location to an academy
export async function addAcademyLocation(
  academyProfileId: string,
  locationId: string,
  contractType: 'exclusive' | 'non_exclusive' = 'non_exclusive',
  contractStart?: string,
  contractEnd?: string
): Promise<{ success: boolean; error?: string }> {
  // Check if already added
  const { data: existing } = await supabase
    .from('academy_locations')
    .select('id')
    .eq('academy_profile_id', academyProfileId)
    .eq('location_id', locationId)
    .maybeSingle();

  if (existing) {
    return { success: false, error: 'This location is already added to your academy' };
  }

  const { error } = await supabase.from('academy_locations').insert({
    academy_profile_id: academyProfileId,
    location_id: locationId,
    contract_type: contractType,
    contract_start: contractStart || null,
    contract_end: contractEnd || null,
    is_active: true,
    show_on_academy_page: true,
    show_on_club_page: true,
  });

  if (error) {
    console.error('Error adding academy location:', error);
    return { success: false, error: error.message };
  }

  return { success: true };
}

// Update academy location settings
export async function updateAcademyLocation(
  academyLocationId: string,
  updates: {
    contract_type?: 'exclusive' | 'non_exclusive';
    contract_start?: string | null;
    contract_end?: string | null;
    is_active?: boolean;
    show_on_academy_page?: boolean;
    show_on_club_page?: boolean;
  }
): Promise<boolean> {
  const { error } = await supabase
    .from('academy_locations')
    .update(updates)
    .eq('id', academyLocationId);

  if (error) {
    console.error('Error updating academy location:', error);
    return false;
  }

  return true;
}

// Remove a location from an academy
export async function removeAcademyLocation(academyLocationId: string): Promise<boolean> {
  const { error } = await supabase
    .from('academy_locations')
    .delete()
    .eq('id', academyLocationId);

  if (error) {
    console.error('Error removing academy location:', error);
    return false;
  }

  return true;
}

// ===================== Trainer Invitation Functions =====================

export interface AcademyTrainerInvitation {
  id: string;
  academy_profile_id: string;
  trainer_email: string;
  trainer_profile_id: string | null;
  invited_by: string;
  status: 'pending' | 'accepted' | 'declined' | 'expired';
  payment_percentage: number;
  message: string | null;
  token: string;
  created_at: string;
  responded_at: string | null;
}

// Invite a trainer to the academy
export async function inviteAcademyTrainer(
  academyProfileId: string,
  trainerEmail: string,
  invitedBy: string,
  message?: string
): Promise<{ success: boolean; invitation?: AcademyTrainerInvitation; error?: string }> {
  // Check if trainer is already part of academy
  const { data: existingTrainer } = await supabase
    .from('academy_trainers')
    .select('id')
    .eq('academy_profile_id', academyProfileId)
    .eq('status', 'active');

  // Check if there's already a pending invitation
  const { data: existingInvitation } = await supabase
    .from('academy_trainer_invitations')
    .select('id')
    .eq('academy_profile_id', academyProfileId)
    .eq('trainer_email', trainerEmail.toLowerCase())
    .eq('status', 'pending')
    .maybeSingle();

  if (existingInvitation) {
    return { success: false, error: 'An invitation is already pending for this email' };
  }

  // Find if trainer has a profile with this email
  const { data: trainerProfile } = await supabase
    .from('profiles')
    .select('user_id')
    .eq('email', trainerEmail.toLowerCase())
    .maybeSingle();

  let trainerProfileId: string | null = null;
  if (trainerProfile) {
    const { data: tp } = await supabase
      .from('trainer_profiles')
      .select('id')
      .eq('user_id', trainerProfile.user_id)
      .maybeSingle();
    trainerProfileId = tp?.id || null;

    // Check if this trainer is already active in the academy
    if (trainerProfileId) {
      const alreadyActive = existingTrainer?.some((t: any) => t.trainer_profile_id === trainerProfileId);
      if (alreadyActive) {
        return { success: false, error: 'This trainer is already part of your academy' };
      }
    }
  }

  // Create invitation (use default payment_percentage of 100 since academies pay salaries directly)
  const { data: invitation, error } = await supabase
    .from('academy_trainer_invitations')
    .insert({
      academy_profile_id: academyProfileId,
      trainer_email: trainerEmail.toLowerCase(),
      trainer_profile_id: trainerProfileId,
      invited_by: invitedBy,
      payment_percentage: 100, // Default value, not used for academy trainers
      message: message || null,
      status: 'pending',
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating academy trainer invitation:', error);
    return { success: false, error: error.message };
  }

  return { success: true, invitation: invitation as AcademyTrainerInvitation };
}

// Get invitation by token
export async function getAcademyInvitationByToken(token: string): Promise<any | null> {
  const { data, error } = await supabase
    .from('academy_trainer_invitations')
    .select(`
      *,
      academy_profiles(id, name, slug, logo_url, description)
    `)
    .eq('token', token)
    .maybeSingle();

  if (error || !data) {
    console.error('Error fetching academy invitation:', error);
    return null;
  }

  // Get inviter name
  const { data: inviterProfile } = await supabase
    .from('profiles')
    .select('full_name')
    .eq('user_id', data.invited_by)
    .maybeSingle();

  return {
    ...data,
    inviter_name: inviterProfile?.full_name || 'Unknown',
  };
}

// Respond to trainer invitation (accept/decline)
export async function respondToAcademyTrainerInvitation(
  token: string,
  accept: boolean,
  userId: string
): Promise<{ success: boolean; error?: string }> {
  // Get the invitation
  const { data: invitation, error: fetchError } = await supabase
    .from('academy_trainer_invitations')
    .select('*')
    .eq('token', token)
    .eq('status', 'pending')
    .maybeSingle();

  if (fetchError || !invitation) {
    return { success: false, error: 'Invitation not found or already responded' };
  }

  // Get trainer profile for this user
  const { data: trainerProfile } = await supabase
    .from('trainer_profiles')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();

  if (!trainerProfile) {
    return { success: false, error: 'You must be a trainer to accept this invitation' };
  }

  // Update invitation status
  const { error: updateError } = await supabase
    .from('academy_trainer_invitations')
    .update({
      status: accept ? 'accepted' : 'declined',
      responded_at: new Date().toISOString(),
      trainer_profile_id: trainerProfile.id,
    })
    .eq('id', invitation.id);

  if (updateError) {
    console.error('Error updating invitation:', updateError);
    return { success: false, error: updateError.message };
  }

  // If accepted, create the academy_trainers record
  if (accept) {
    const { error: trainerError } = await supabase
      .from('academy_trainers')
      .insert({
        academy_profile_id: invitation.academy_profile_id,
        trainer_profile_id: trainerProfile.id,
        status: 'active',
        payment_percentage: invitation.payment_percentage,
        invited_by: invitation.invited_by,
        joined_at: new Date().toISOString(),
      });

    if (trainerError) {
      console.error('Error creating academy trainer:', trainerError);
      // Try to rollback invitation status
      await supabase
        .from('academy_trainer_invitations')
        .update({ status: 'pending', responded_at: null })
        .eq('id', invitation.id);
      return { success: false, error: trainerError.message };
    }
  }

  return { success: true };
}

// Get all trainers for academy (including invited)
export async function getAcademyTrainersWithProfiles(academyProfileId: string): Promise<any[]> {
  const { data, error } = await supabase
    .from('academy_trainers')
    .select(`
      *,
      trainer_profile:trainer_profiles(
        id,
        user_id,
        hourly_rate,
        experience_years,
        specializations,
        certifications,
        is_verified
      )
    `)
    .eq('academy_profile_id', academyProfileId);

  if (error) {
    console.error('Error fetching academy trainers:', error);
    return [];
  }

  if (!data || data.length === 0) return [];

  // Batch fetch profiles
  const userIds = data.map((t: any) => t.trainer_profile?.user_id).filter(Boolean);
  const { data: profiles } = await supabase
    .from('profiles_public')
    .select('user_id, full_name, avatar_url')
    .in('user_id', userIds);

  const profileMap = new Map((profiles || []).map((p) => [p.user_id, p]));

  return data.map((trainer: any) => ({
    ...trainer,
    profile: trainer.trainer_profile?.user_id 
      ? profileMap.get(trainer.trainer_profile.user_id) || null 
      : null,
  }));
}

// Get pending invitations for academy
export async function getAcademyPendingInvitations(academyProfileId: string): Promise<any[]> {
  const { data, error } = await supabase
    .from('academy_trainer_invitations')
    .select('*')
    .eq('academy_profile_id', academyProfileId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching pending invitations:', error);
    return [];
  }

  return data || [];
}

// Update trainer payment percentage
export async function updateAcademyTrainerPayment(
  academyTrainerId: string,
  paymentPercentage: number
): Promise<boolean> {
  const { error } = await supabase
    .from('academy_trainers')
    .update({ payment_percentage: paymentPercentage })
    .eq('id', academyTrainerId);

  if (error) {
    console.error('Error updating trainer payment:', error);
    return false;
  }

  return true;
}

// Update trainer visibility on academy page
export async function updateAcademyTrainerVisibility(
  academyTrainerId: string,
  showOnAcademyPage: boolean
): Promise<boolean> {
  const { error } = await supabase
    .from('academy_trainers')
    .update({ show_on_academy_page: showOnAcademyPage })
    .eq('id', academyTrainerId);

  if (error) {
    console.error('Error updating trainer visibility:', error);
    return false;
  }

  return true;
}

// Remove trainer from academy
export async function removeAcademyTrainer(academyTrainerId: string): Promise<boolean> {
  const { error } = await supabase
    .from('academy_trainers')
    .update({ status: 'inactive' })
    .eq('id', academyTrainerId);

  if (error) {
    console.error('Error removing trainer from academy:', error);
    return false;
  }

  return true;
}

// Cancel pending invitation
export async function cancelAcademyInvitation(invitationId: string): Promise<boolean> {
  const { error } = await supabase
    .from('academy_trainer_invitations')
    .update({ status: 'expired' })
    .eq('id', invitationId)
    .eq('status', 'pending');

  if (error) {
    console.error('Error canceling invitation:', error);
    return false;
  }

  return true;
}

// ===== PUBLIC PROFILE FUNCTIONS =====

// Get public trainers for an academy (for public profile page)
export async function getPublicAcademyTrainers(academyProfileId: string): Promise<any[]> {
  const { data, error } = await supabase
    .from('academy_trainers')
    .select(`
      id,
      trainer_profile_id,
      trainer_profile:trainer_profiles_safe(
        id,
        user_id,
        hourly_rate,
        experience_years,
        specializations,
        certifications,
        is_verified
      )
    `)
    .eq('academy_profile_id', academyProfileId)
    .eq('status', 'active')
    .eq('show_on_academy_page', true);

  if (error) {
    console.error('Error fetching public academy trainers:', error);
    return [];
  }

  if (!data || data.length === 0) return [];

  // Batch fetch profiles
  const userIds = data.map((t: any) => t.trainer_profile?.user_id).filter(Boolean);
  const { data: profiles } = await supabase
    .from('profiles_public')
    .select('user_id, full_name, avatar_url, bio, location')
    .in('user_id', userIds);

  // Batch fetch ratings
  const trainerIds = data.map((t: any) => t.trainer_profile_id).filter(Boolean);
  const { data: reviews } = await supabase
    .from('reviews')
    .select('trainer_id, rating')
    .in('trainer_id', trainerIds)
    .eq('is_public', true);

  const ratingsByTrainer: Record<string, number[]> = {};
  reviews?.forEach(review => {
    if (!ratingsByTrainer[review.trainer_id]) {
      ratingsByTrainer[review.trainer_id] = [];
    }
    ratingsByTrainer[review.trainer_id].push(review.rating);
  });

  const profileMap = new Map((profiles || []).map((p) => [p.user_id, p]));

  return data
    .map((trainer: any) => ({
      ...trainer,
      profile: trainer.trainer_profile?.user_id 
        ? profileMap.get(trainer.trainer_profile.user_id) || null 
        : null,
      avgRating: ratingsByTrainer[trainer.trainer_profile_id]
        ? ratingsByTrainer[trainer.trainer_profile_id].reduce((a, b) => a + b, 0) / ratingsByTrainer[trainer.trainer_profile_id].length
        : undefined,
    }))
    .filter((t: any) => t.profile?.full_name);
}

// Get public locations for an academy (for public profile page)
export async function getPublicAcademyLocations(academyProfileId: string): Promise<any[]> {
  const { data, error } = await supabase
    .from('academy_locations')
    .select(`
      id,
      location_id,
      contract_type,
      location:locations(id, name, city, slug, logo_url, street_address, postal_code)
    `)
    .eq('academy_profile_id', academyProfileId)
    .eq('is_active', true)
    .eq('show_on_academy_page', true);

  if (error) {
    console.error('Error fetching public academy locations:', error);
    return [];
  }

  return data || [];
}

// Get all public academies for directory (uses public view which requires is_verified AND is_public)
export async function getPublicAcademies(): Promise<Partial<AcademyProfile>[]> {
  const { data, error } = await supabase
    .from('academy_profiles_public')
    .select('*')
    .order('name');

  if (error) {
    console.error('Error fetching public academies:', error);
    return [];
  }

  return data || [];
}
