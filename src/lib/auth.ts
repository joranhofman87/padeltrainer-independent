import { supabase } from "@/integrations/supabase/client";

export type UserRole = 'player' | 'trainer' | 'admin' | 'club';

export interface UserProfile {
  id: string;
  user_id: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  bio: string | null;
  phone: string | null;
  location: string | null;
  skill_rating: number | null;
  rating_member_id: string | null;
  rating_system: string;
  created_at: string;
  updated_at: string;
}

export interface TrainerProfile {
  id: string;
  user_id: string;
  hourly_rate: number | null;
  experience_years: number | null;
  certifications: string[] | null;
  specializations: string[] | null;
  is_verified: boolean;
  subscription_status: string;
  stripe_account_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function signUpWithEmail(email: string, password: string, fullName: string, phone?: string) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: window.location.origin,
      data: {
        full_name: fullName,
        phone: phone,
      },
    },
  });
  
  // Update profile with phone number after signup
  if (data.user && phone) {
    await supabase
      .from('profiles')
      .update({ phone })
      .eq('user_id', data.user.id);
  }
  
  return { data, error };
}

export async function signInWithEmail(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  return { data, error };
}

export async function signInWithGoogle() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${window.location.origin}/auth`,
    },
  });
  return { data, error };
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  return { error };
}

export async function getUserRole(userId: string): Promise<UserRole | null> {
  const roles = await getUserRoles(userId);
  if (roles.length === 0) return null;
  
  // Return primary role based on priority: admin > trainer > club > player
  if (roles.includes('admin')) return 'admin';
  if (roles.includes('trainer')) return 'trainer';
  if (roles.includes('club')) return 'club';
  if (roles.includes('player')) return 'player';
  return null;
}

export async function getUserRoles(userId: string): Promise<UserRole[]> {
  const { data, error } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', userId);
  
  if (error || !data) return [];
  return data.map(d => d.role as UserRole);
}

export async function setUserRole(userId: string, role: UserRole) {
  const { data, error } = await supabase
    .from('user_roles')
    .insert({ user_id: userId, role })
    .select()
    .single();
  
  if (error) throw error;
  
  // If trainer, also create trainer profile with trial dates
  if (role === 'trainer') {
    const now = new Date();
    const trialEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days from now
    
    const { error: trainerError } = await supabase
      .from('trainer_profiles')
      .insert({ 
        user_id: userId,
        trial_started_at: now.toISOString(),
        trial_ends_at: trialEnd.toISOString(),
        subscription_status: 'trial',
        is_public: false,
      });
    
    if (trainerError) throw trainerError;
  }
  
  return data;
}

export async function getProfile(userId: string): Promise<UserProfile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('user_id', userId)
    .single();
  
  if (error || !data) return null;
  return data as UserProfile;
}

export async function updateProfile(userId: string, updates: Partial<UserProfile>) {
  const { data, error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('user_id', userId)
    .select()
    .single();
  
  if (error) throw error;
  return data;
}

export async function getTrainerProfile(userId: string): Promise<TrainerProfile | null> {
  const { data, error } = await supabase
    .from('trainer_profiles')
    .select('*')
    .eq('user_id', userId)
    .single();
  
  if (error || !data) return null;
  return data as TrainerProfile;
}

export async function sendPasswordResetEmail(email: string) {
  const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/reset-password`,
  });
  return { data, error };
}

export async function updatePassword(newPassword: string) {
  const { data, error } = await supabase.auth.updateUser({ password: newPassword });
  return { data, error };
}
