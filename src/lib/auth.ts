import { supabase } from "@/lib/supabaseClient";
import { getAuthRedirectUrl } from "@/lib/domains";
import { logger } from '@/lib/logger';
import { buildFullName } from '@/lib/profileName';
import { createSignupFailure, extractSignupResponseError, normalizeSignupFailure, SIGNUP_ERROR_CODE } from '@/lib/signupErrors';

export type { SignupFailure, SignupErrorCode } from '@/lib/signupErrors';
export { SIGNUP_ERROR_CODE, isSignupEmailAlreadyRegistered, normalizeSignupFailure } from '@/lib/signupErrors';

function normalizeAuthError(error: any, fallbackMessage: string) {
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  const name = typeof error?.name === 'string' ? error.name : '';
  const status = typeof error?.status === 'number' ? error.status : undefined;
  const code = typeof error?.code === 'string' ? error.code : undefined;

  const isRetryable = name === 'AuthRetryableFetchError';
  const isServiceUnavailable = status === 503 || status === 504 || message.includes('503') || message.includes('504');
  const isNetworkLike = isRetryable || message.includes('Failed to fetch') || message.includes('NetworkError') || message.includes('fetch failed') || message.includes('Load failed');

  return {
    ...error,
    name: name || 'AuthError',
    status,
    code,
    message: isServiceUnavailable || isNetworkLike
      ? 'Login is temporarily unavailable. Please try again in a moment.'
      : message || fallbackMessage,
  };
}
export type UserRole = 'player' | 'trainer' | 'admin' | 'club' | 'academy';

/** Roles assignable during signup / OAuth completion (not admin). */
export type SignupRole = 'player' | 'trainer' | 'club' | 'academy';

export const SIGNUP_ROLE_ALLOWLIST: SignupRole[] = ['player', 'trainer', 'club', 'academy'];

export function isSignupRole(value: string | null | undefined): value is SignupRole {
  return !!value && (SIGNUP_ROLE_ALLOWLIST as string[]).includes(value);
}

/** Post-OAuth / post-signup onboarding entry routes by role. */
export function getOnboardingRouteForSignupRole(role: SignupRole): string {
  switch (role) {
    case 'academy':
      return '/app/academy/onboarding';
    case 'club':
      return '/app/onboarding/club';
    case 'trainer':
      return '/app/onboarding/trainer';
    case 'player':
      return '/app/onboarding/player';
    default:
      return '/app/onboarding/player';
  }
}

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

function matchesSignupRoleArg(value?: string): boolean {
  return isSignupRole(value?.toLowerCase());
}

function looksLikePhone(value: string): boolean {
  return /^\+?[\d\s()-]{8,}$/.test(value.trim());
}

/**
 * Legacy: signUpWithEmail(email, password, fullName, phone?, language?, role?, timezone?)
 * Structured: signUpWithEmail(email, password, firstName, lastName, phone?, language?, role?, timezone?)
 *
 * A separate lastName must not be treated as legacy (e.g. surname "Club" → invalid role "Club").
 */
function isLegacySignUpArgs(lastNameOrPhone?: string): boolean {
  if (lastNameOrPhone === undefined) return true;
  return looksLikePhone(lastNameOrPhone);
}

/** Normalize client role before signup-user (allowlist is lowercase only). */
function normalizeSignupRole(role?: string): SignupRole | undefined {
  if (!role) return undefined;
  const lower = role.toLowerCase();
  return isSignupRole(lower) ? lower : undefined;
}

function resolveSignUpNameArgs(
  firstNameOrFullName: string,
  lastNameOrPhone?: string,
  phoneOrLanguage?: string,
  languageOrRole?: string,
  roleOrTimezone?: string,
  timezone?: string,
): {
  firstName: string;
  lastName: string;
  fullName: string;
  phone?: string;
  language?: string;
  role?: string;
  timezone?: string;
} {
  if (isLegacySignUpArgs(lastNameOrPhone)) {
    const trimmed = firstNameOrFullName.trim();
    const parts = trimmed.split(/\s+/).filter(Boolean);
    const firstName = parts[0] ?? trimmed;
    const lastName = parts.length > 1 ? parts.slice(1).join(' ') : firstName;

    let phone: string | undefined;
    let language: string | undefined;
    let role: string | undefined;
    let tz: string | undefined;

    if (lastNameOrPhone === undefined) {
      // (email, password, fullName, undefined, language?, role?, timezone?)
      language = phoneOrLanguage;
      role = languageOrRole;
      tz = roleOrTimezone ?? timezone;
    } else if (looksLikePhone(lastNameOrPhone)) {
      phone = lastNameOrPhone;
      language = phoneOrLanguage;
      role = languageOrRole;
      tz = roleOrTimezone ?? timezone;
    } else if (matchesSignupRoleArg(lastNameOrPhone)) {
      role = lastNameOrPhone;
      language = phoneOrLanguage;
      tz = languageOrRole ?? timezone;
    } else if (matchesSignupRoleArg(phoneOrLanguage)) {
      role = phoneOrLanguage;
      language = lastNameOrPhone;
      tz = languageOrRole ?? timezone;
    } else {
      language = lastNameOrPhone;
      role = phoneOrLanguage;
      tz = languageOrRole ?? timezone;
    }

    return {
      firstName,
      lastName,
      fullName: trimmed,
      phone,
      language,
      role,
      timezone: tz ?? timezone,
    };
  }

  const firstName = firstNameOrFullName.trim();
  const lastName = (lastNameOrPhone ?? '').trim();
  return {
    firstName,
    lastName,
    fullName: buildFullName(firstName, lastName),
    phone: phoneOrLanguage,
    language: languageOrRole,
    role: roleOrTimezone,
    timezone,
  };
}

export async function signUpWithEmail(
  email: string,
  password: string,
  firstNameOrFullName: string,
  lastNameOrPhone?: string,
  phoneOrLanguage?: string,
  languageOrRole?: string,
  roleOrTimezone?: string,
  timezone?: string,
) {
  const resolved = resolveSignUpNameArgs(
    firstNameOrFullName,
    lastNameOrPhone,
    phoneOrLanguage,
    languageOrRole,
    roleOrTimezone,
    timezone,
  );

  // Use custom edge function to create user with Admin API
  // This bypasses Supabase's automatic email and sends our branded email instead
  try {
    const detectedTimezone =
      resolved.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Amsterdam';
    const signupRole = normalizeSignupRole(resolved.role);
    const { data: response, error: invokeError } = await supabase.functions.invoke('signup-user', {
      body: {
        email,
        password,
        firstName: resolved.firstName,
        lastName: resolved.lastName,
        fullName: resolved.fullName,
        phone: resolved.phone,
        language: resolved.language,
        role: signupRole,
        timezone: detectedTimezone,
        redirectTo: getAuthRedirectUrl('/app/auth'),
      },
    });

    const responseError = extractSignupResponseError(response);
    if (invokeError || responseError) {
      const failure = normalizeSignupFailure(invokeError, response);
      logger.error(
        'Signup function error',
        (invokeError as Error) ?? new Error(responseError ?? 'signup-user failed'),
        { component: 'auth', code: failure.code, responseError },
      );
      return {
        data: { user: null, session: null },
        error: failure,
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
  } catch (err: unknown) {
    logger.error('Signup error', err as Error, { component: 'auth' });
    return {
      data: { user: null, session: null },
      error: createSignupFailure(
        SIGNUP_ERROR_CODE.GENERIC,
        err instanceof Error ? err.message : 'Failed to create account',
      ),
    };
  }
}

async function attemptSignIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  return { data, error };
}

function isRetryableAuthError(error: any): boolean {
  if (!error) return false;
  const status = error.status;
  const name = error.name || '';
  const message = (error.message || '').toLowerCase();
  return (
    status === 503 || status === 504 || status === 429 ||
    name === 'AuthRetryableFetchError' ||
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('fetch failed') ||
    message.includes('load failed')
  );
}

export async function signInWithEmail(email: string, password: string) {
  try {
    const { data, error } = await attemptSignIn(email, password);

    if (error && isRetryableAuthError(error)) {
      logger.error('Sign in retryable error, retrying in 2s', error as Error, {
        component: 'auth',
        action: 'signInWithEmailRetry',
        status: error.status,
      });
      // Wait 2 seconds and retry once
      await new Promise(resolve => setTimeout(resolve, 2000));
      const retry = await attemptSignIn(email, password);
      if (retry.error) {
        const normalizedError = normalizeAuthError(retry.error, 'Login is temporarily unavailable. Please try again in a moment.');
        logger.error('Sign in retry also failed', normalizedError as Error, { component: 'auth', action: 'signInWithEmailRetryFailed' });
        return { data: retry.data, error: normalizedError as any };
      }
      return { data: retry.data, error: null };
    }

    if (error) {
      const normalizedError = normalizeAuthError(error, 'Unable to sign in. Please check your email and password and try again.');
      logger.error('Sign in failed', normalizedError as Error, {
        component: 'auth',
        action: 'signInWithEmail',
        status: (normalizedError as any).status,
        code: (normalizedError as any).code,
        name: normalizedError.name,
      });
      return { data, error: normalizedError as any };
    }

    return { data, error: null };
  } catch (err: any) {
    // Catch-level: also retry once on network failures
    if (isRetryableAuthError(err)) {
      try {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const retry = await attemptSignIn(email, password);
        if (!retry.error) return { data: retry.data, error: null };
      } catch (_) { /* fall through */ }
    }
    const normalizedError = normalizeAuthError(err, 'Login is temporarily unavailable. Please try again in a moment.');
    logger.error('Sign-in network failure', normalizedError as Error, {
      component: 'auth',
      action: 'signInWithEmailCatch',
      status: (normalizedError as any).status,
      code: (normalizedError as any).code,
      name: normalizedError.name,
    });
    return {
      data: { user: null, session: null },
      error: normalizedError as any,
    };
  }
}

export async function signInWithGoogle() {
  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: getAuthRedirectUrl('/app/auth'),
      },
    });

    if (error) {
      const normalizedError = normalizeAuthError(error, 'Google sign-in is temporarily unavailable. Please try again.');
      logger.error('Google sign in failed', normalizedError as Error, {
        component: 'auth',
        action: 'signInWithGoogle',
        status: (normalizedError as any).status,
        code: (normalizedError as any).code,
        name: normalizedError.name,
      });
      return { data, error: normalizedError as any };
    }

    return { data, error: null };
  } catch (err: any) {
    const normalizedError = normalizeAuthError(err, 'Google sign-in is temporarily unavailable. Please try again.');
    logger.error('Google sign-in network failure', normalizedError as Error, {
      component: 'auth',
      action: 'signInWithGoogleCatch',
      status: (normalizedError as any).status,
      code: (normalizedError as any).code,
      name: normalizedError.name,
    });
    return {
      data: null,
      error: normalizedError as any,
    };
  }
}

/** Complete Google OAuth signup server-side (roles, profile names, trainer trial). */
export async function completeOAuthSignup(
  role: SignupRole,
  timezone?: string,
): Promise<{ success: boolean; error: Error | null }> {
  const detectedTimezone =
    timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Amsterdam';

  try {
    const { data, error: invokeError } = await supabase.functions.invoke('complete-oauth-signup', {
      body: { role, timezone: detectedTimezone },
    });

    if (invokeError) {
      logger.error('complete-oauth-signup invoke failed', invokeError as Error, { component: 'auth', role });
      return { success: false, error: new Error(invokeError.message) };
    }

    const payload = data as { success?: boolean; error?: string } | null;
    if (!payload?.success) {
      const message = payload?.error || 'Failed to complete signup';
      return { success: false, error: new Error(message) };
    }

    return { success: true, error: null };
  } catch (err) {
    logger.error('completeOAuthSignup failed', err as Error, { component: 'auth', role });
    return { success: false, error: err as Error };
  }
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  return { error };
}

export async function getUserRole(userId: string): Promise<UserRole | null> {
  const { data: roles } = await getUserRoles(userId);
  if (roles.length === 0) return null;
  
  // Return primary role based on priority: admin > trainer > academy > club > player
  if (roles.includes('admin')) return 'admin';
  if (roles.includes('trainer')) return 'trainer';
  if (roles.includes('academy')) return 'academy';
  if (roles.includes('club')) return 'club';
  if (roles.includes('player')) return 'player';
  return null;
}

export interface FetchResult<T> {
  data: T;
  failed: boolean;
}

const CHECKED_USER_ROLES: UserRole[] = ['admin', 'trainer', 'academy', 'club', 'player'];

/** Read roles via SECURITY DEFINER RPC — direct user_roles SELECT may be blocked by RLS. */
export async function getUserRoles(userId: string): Promise<FetchResult<UserRole[]>> {
  try {
    const results = await Promise.all(
      CHECKED_USER_ROLES.map(async (role) => {
        const { data, error } = await supabase.rpc('has_role', {
          _user_id: userId,
          _role: role,
        });
        return { role, has: !!data, error };
      }),
    );

    const failed = results.find((r) => r.error);
    if (failed?.error) {
      logger.error('Error fetching user roles via has_role', failed.error as any, { component: 'auth' });
      return { data: [], failed: true };
    }

    return { data: results.filter((r) => r.has).map((r) => r.role), failed: false };
  } catch (err) {
    logger.error('Exception fetching user roles', err as Error, { component: 'auth' });
    return { data: [], failed: true };
  }
}

/** Idempotent: create trial trainer_profiles row only when missing. */
export async function ensureTrainerProfile(userId: string, timezone?: string) {
  const { data: existing } = await supabase
    .from('trainer_profiles')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();

  if (existing) return;

  const now = new Date();
  const trialEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Amsterdam';

  const { error: trainerError } = await supabase.from('trainer_profiles').insert({
    user_id: userId,
    trial_started_at: now.toISOString(),
    trial_ends_at: trialEnd.toISOString(),
    subscription_status: 'trial',
    is_public: false,
    timezone: tz,
  });

  if (trainerError) throw trainerError;
}

export async function isTrainerOnboardingComplete(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('trainer_onboarding')
    .select('completed_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return !!data?.completed_at;
}

/**
 * Assign role when missing. Skips client INSERT when signup-user (or admin) already assigned it.
 * Legacy users without a row still attempt INSERT (may fail under RLS — caller should handle).
 */
export async function setUserRole(userId: string, role: UserRole, timezone?: string) {
  const { data: alreadyHas, error: checkError } = await supabase.rpc('has_role', {
    _user_id: userId,
    _role: role,
  });

  if (checkError) {
    logger.error('Error checking role before assign', checkError as any, { component: 'auth', role });
    throw checkError;
  }

  if (alreadyHas) {
    if (role === 'trainer') {
      await ensureTrainerProfile(userId, timezone);
    }
    return { user_id: userId, role };
  }

  const { data, error } = await supabase
    .from('user_roles')
    .insert({ user_id: userId, role })
    .select()
    .single();

  if (error) {
    const { data: nowHas } = await supabase.rpc('has_role', { _user_id: userId, _role: role });
    if (nowHas) {
      if (role === 'trainer') {
        await ensureTrainerProfile(userId, timezone);
      }
      return { user_id: userId, role };
    }
    throw error;
  }

  if (role === 'trainer') {
    await ensureTrainerProfile(userId, timezone);
  }

  return data;
}

export async function getProfile(userId: string): Promise<FetchResult<UserProfile | null>> {
  try {
    const { data, error } = await supabase
      .from('profiles_owner' as any)
      .select('*')
      .eq('user_id', userId)
      .single();
    
    if (error) {
      // PGRST116 = no rows found — that's a valid "no profile" result, not a failure
      if (error.code === 'PGRST116') return { data: null, failed: false };
      logger.error('Error fetching profile', error as any, { component: 'auth' });
      return { data: null, failed: true };
    }
    return { data: data as unknown as UserProfile, failed: false };
  } catch (err) {
    logger.error('Exception fetching profile', err as Error, { component: 'auth' });
    return { data: null, failed: true };
  }
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
    .from('trainer_profiles_owner' as any)
    .select('*')
    .eq('user_id', userId)
    .single();
  
  if (error || !data) return null;
  return data as unknown as TrainerProfile;
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
