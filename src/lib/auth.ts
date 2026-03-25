import { supabase } from "@/lib/supabaseClient";
import { getAuthRedirectUrl } from "@/lib/domains";
import { logger } from '@/lib/logger';

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
  preferred_language: string | null;
  created_at: string;
  updated_at: string;
}

export interface TrainerProfile {
  id: string;
  user_id: string;
  slug: string;
  hourly_rate: number | null;
  experience_years: number | null;
  certifications: string[] | null;
  specializations: string[] | null;
  is_verified: boolean;
  subscription_status: string;
  created_at: string;
  updated_at: string;
}

export async function signUpWithEmail(email: string, password: string, fullName: string, phone?: string, language?: string, role?: string) {
  // Use custom edge function to create user with Admin API
  // This bypasses Supabase's automatic email and sends our branded email instead
  try {
    const { data: response, error: invokeError } = await supabase.functions.invoke('signup-user', {
      body: {
        email,
        password,
        fullName,
        phone,
        language,
        redirectTo: getAuthRedirectUrl('/app/auth'),
      },
    });

    if (invokeError) {
      logger.error('Signup function error', invokeError as Error, { component: 'auth' });
      return { 
        data: { user: null, session: null }, 
        error: { message: invokeError.message || 'Failed to create account', name: 'SignupError' } as any 
      };
    }

    if (response?.error) {
      return { 
        data: { user: null, session: null }, 
        error: { message: response.error, name: 'SignupError' } as any 
      };
    }

    // User created successfully with email auto-confirmed
    // Sign in immediately to establish a session
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      logger.error('Auto sign-in after signup failed', signInError as Error, { component: 'auth' });
      // User was created but sign-in failed — fall back to manual login
      return { 
        data: { user: response?.user || null, session: null }, 
        error: null 
      };
    }

    // Track signup conversion in Reditus (affiliate tracking) — fires only here at signup
    if (signInData.user && typeof window !== 'undefined' && (window as any).gr) {
      (window as any).gr('track', 'conversion', {
        email: signInData.user.email,
        uid: signInData.user.id,
      });
    }

    return { 
      data: { 
        user: signInData.user, 
        session: signInData.session 
      }, 
      error: null 
    };
  } catch (err: any) {
    logger.error('Signup error', err as Error, { component: 'auth' });
    return { 
      data: { user: null, session: null }, 
      error: { message: err.message || 'Failed to create account', name: 'SignupError' } as any 
    };
  }
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
      redirectTo: getAuthRedirectUrl('/app/auth'),
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
  // Use custom edge function to send branded password reset email from padeltrainer.ai
  try {
    const { data, error } = await supabase.functions.invoke('send-auth-email', {
      body: {
        type: 'password_reset',
        email,
        redirectTo: getAuthRedirectUrl('/app/reset-password'),
      },
    });
    
    if (error) {
      throw error;
    }
    
    return { data, error: null };
  } catch (error: any) {
    logger.error('Failed to send password reset email', error as Error, { component: 'auth' });
    // Fallback to Supabase default if custom email fails
    const { data, error: supabaseError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: getAuthRedirectUrl('/app/reset-password'),
    });
    return { data, error: supabaseError };
  }
}

export async function updatePassword(newPassword: string) {
  const { data, error } = await supabase.auth.updateUser({ password: newPassword });
  return { data, error };
}
