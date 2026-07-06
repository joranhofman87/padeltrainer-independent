import { useEffect, useState, useRef, createContext, useContext, ReactNode, useCallback } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabaseClient';
import { getUserRoles, getProfile, UserRole, UserProfile } from '@/lib/auth';
import { SubscriptionInfo, SubscriptionTier } from '@/lib/subscription';
import { isUserClubManager } from '@/lib/club';
import { logger } from '@/lib/logger';
import { isUserAcademyManager } from '@/lib/academy';
import { identifyUser, resetUser } from '@/lib/tracking';
import { logSubscriptionFallback, readCachedSubscription, writeCachedSubscription } from '@/lib/subscriptionCache';
import i18n from '@/i18n';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  profile: UserProfile | null;
  role: UserRole | null;
  roles: UserRole[];
  isClubManager: boolean;
  isAcademyManager: boolean;
  subscription: SubscriptionInfo | null;
  loading: boolean;
  /** True once we positively fetched user data (or confirmed no user). False while still loading profile/roles. */
  profileReady: boolean;
  /** True if the last profile/role fetch failed due to network/auth errors */
  profileFetchFailed: boolean;
  refreshAuth: () => Promise<void>;
  refreshSubscription: () => Promise<void>;
}

// U-12: a transient profile/roles failure used to leave roles empty (layout guards then
// bounce a logged-in user to the login form) and a hung fetch pinned the bootstrap
// skeleton. Retry with backoff and time-box each attempt so the fetch always settles.
const USER_DATA_FETCH_ATTEMPTS = 3;
const USER_DATA_ATTEMPT_TIMEOUT_MS = 4_000;
const USER_DATA_RETRY_BACKOFF_MS = [500, 1_000];

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// supabase-js persists the session under `sb-<project-ref>-auth-token`. Derive the
// ref from the configured URL so this never points at a stale/old project (U-24).
const SUPABASE_AUTH_STORAGE_KEY = (() => {
  try {
    const projectRef = new URL(import.meta.env.VITE_SUPABASE_URL).hostname.split('.')[0];
    return projectRef ? `sb-${projectRef}-auth-token` : null;
  } catch {
    return null;
  }
})();

const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  profile: null,
  role: null,
  roles: [],
  isClubManager: false,
  isAcademyManager: false,
  subscription: null,
  loading: true,
  profileReady: false,
  profileFetchFailed: false,
  refreshAuth: async () => {},
  refreshSubscription: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [role, setRole] = useState<UserRole | null>(null);
  const [roles, setRoles] = useState<UserRole[]>([]);
  const [isClubManager, setIsClubManager] = useState(false);
  const [isAcademyManager, setIsAcademyManager] = useState(false);
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileReady, setProfileReady] = useState(false);
  const [profileFetchFailed, setProfileFetchFailed] = useState(false);
  const lastFetchedRef = useRef<string | null>(null);

  const fetchUserData = async (userId: string) => {
    const attemptFetch = () =>
      Promise.race([
        Promise.all([
          getUserRoles(userId),
          getProfile(userId),
          isUserClubManager(userId),
          isUserAcademyManager(userId),
        ]),
        // Reject hung attempts so profileReady always resolves and the skeleton never pins
        wait(USER_DATA_ATTEMPT_TIMEOUT_MS).then(() => {
          throw new Error('User data fetch timed out');
        }),
      ]);

    let lastError: unknown = null;

    for (let attempt = 0; attempt < USER_DATA_FETCH_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await wait(USER_DATA_RETRY_BACKOFF_MS[attempt - 1] ?? 1_000);
      }

      // User signed out or switched while we were retrying — drop stale results
      if (lastFetchedRef.current !== userId) return;

      try {
        const [rolesResult, profileResult, clubResult, academyResult] = await attemptFetch();

        // Check if any critical fetch failed
        const anyFailed = rolesResult.failed || profileResult.failed || clubResult.failed || academyResult.failed;
        if (anyFailed && attempt < USER_DATA_FETCH_ATTEMPTS - 1) {
          continue; // transient backend failure — retry before surfacing
        }

        if (lastFetchedRef.current !== userId) return;

        // Determine primary role based on priority: admin > trainer > academy > club > player
        const userRoles = rolesResult.data;
        const primaryRole = userRoles.includes('admin') ? 'admin'
          : userRoles.includes('trainer') ? 'trainer'
          : userRoles.includes('academy') ? 'academy'
          : userRoles.includes('club') ? 'club'
          : userRoles.includes('player') ? 'player'
          : null;

        setRoles(userRoles);
        setRole(primaryRole);
        setIsClubManager(clubResult.data);
        setIsAcademyManager(academyResult.data);
        setProfile(profileResult.data);
        setProfileFetchFailed(anyFailed);
        setProfileReady(true);

        // Apply saved language preference
        const userProfile = profileResult.data;
        if (userProfile?.preferred_language && userProfile.preferred_language !== i18n.language) {
          i18n.changeLanguage(userProfile.preferred_language);
        }

        // Link anonymous browsing history to this user in PostHog
        try {
          identifyUser(userId, {
            role: primaryRole,
            email: userProfile?.email ?? null,
            created_at: userProfile?.created_at ?? null,
          });
        } catch {
          // Analytics must never break auth
        }
        return;
      } catch (err) {
        lastError = err;
      }
    }

    logger.error('Failed to fetch user data after retries', lastError as Error, { component: 'useAuth' });
    if (lastFetchedRef.current !== userId) return;
    setProfileFetchFailed(true);
    setProfileReady(true);
  };

  // A FAILED check must not read as "expired": the old single-shot fallback set
  // isSubscribed/isInTrial false, so one network flake hard-locked PAYING trainers
  // into the paywall with a dead sidebar (TrainerLayout redirects on it). Retry,
  // then fall back to the in-memory state from this session, then to the
  // last-known-good cache from a recent successful check; fail closed only when
  // this device has never seen an entitlement.
  const fetchSubscription = useCallback(async () => {
    if (!session?.access_token) {
      setSubscription(null);
      return;
    }
    const userId = session.user?.id ?? '';

    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 1000));
      try {
        const { data, error } = await supabase.functions.invoke('check-stripe-subscription', {
          body: { type: 'trainer' },
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        });
        if (error) throw error;

        const tier = data.tier || 'trial';
        const next: SubscriptionInfo = {
          isSubscribed: data.subscribed,
          tier: tier as SubscriptionTier,
          subscriptionEnd: data.endsAt || null,
          trialEndsAt: data.trialEndsAt || null,
          isInTrial: data.status === 'trialing',
          isPublic: data.isPublic ?? false,
          managedByAcademy: data.managedByAcademy ?? false,
          academyName: data.academyName ?? null,
        };
        setSubscription(next);
        if (userId) writeCachedSubscription(userId, next);
        return;
      } catch (err) {
        lastError = err;
      }
    }

    logger.error('Error fetching subscription after retries', lastError as Error, { component: 'useAuth' });
    const cached = userId ? readCachedSubscription(userId) : null;
    setSubscription((prev) => {
      if (prev) {
        logSubscriptionFallback('memory');
        return prev;
      }
      if (cached) {
        logSubscriptionFallback('cache');
        return cached;
      }
      logSubscriptionFallback('fail_closed');
      return {
        isSubscribed: false,
        tier: 'trial',
        subscriptionEnd: null,
        trialEndsAt: null,
        isInTrial: false,
        isPublic: false,
        managedByAcademy: false,
        academyName: null,
      };
    });
  }, [session?.access_token, session?.user?.id]);

  const refreshAuth = async () => {
    if (user) {
      // Gate layouts on the in-flight refetch so an empty-roles redirect can't race it
      setProfileReady(false);
      setProfileFetchFailed(false);
      await fetchUserData(user.id);
    }
  };

  const refreshSubscription = useCallback(async () => {
    await fetchSubscription();
  }, [fetchSubscription]);

  useEffect(() => {
    let isActive = true;
    const welcomeEmailsKey = 'hasTriggeredWelcomeEmails';

    const applySessionState = async (
      nextSession: Session | null,
      source: 'bootstrap' | 'listener',
      event?: string,
    ) => {
      if (!isActive) return;

      setSession(nextSession);
      setUser(nextSession?.user ?? null);

      if (nextSession?.user && lastFetchedRef.current !== nextSession.user.id) {
        lastFetchedRef.current = nextSession.user.id;
        setProfileReady(false);
        setProfileFetchFailed(false);

        await Promise.race([
          fetchUserData(nextSession.user.id),
          new Promise((resolve) => setTimeout(resolve, 8000)),
        ]);

        if (
          source === 'listener' &&
          !sessionStorage.getItem(welcomeEmailsKey) &&
          nextSession.user.email_confirmed_at &&
          (event === 'SIGNED_IN' || event === 'USER_UPDATED')
        ) {
          sessionStorage.setItem(welcomeEmailsKey, '1');
          const scheduleIdle =
            typeof window !== 'undefined' && 'requestIdleCallback' in window
              ? window.requestIdleCallback.bind(window)
              : (cb: () => void) => window.setTimeout(cb, 1);
          scheduleIdle(() => {
            supabase.functions.invoke('trigger-welcome-emails', {
              headers: { Authorization: `Bearer ${nextSession.access_token}` },
            }).then(({ error }) => {
              if (error) {
                logger.warn('Failed to trigger welcome emails', { component: 'useAuth', error });
              }
            });
          });
        }
      } else if (!nextSession?.user) {
        lastFetchedRef.current = null;
        setProfile(null);
        setRole(null);
        setRoles([]);
        setIsClubManager(false);
        setIsAcademyManager(false);
        setSubscription(null);
        setProfileReady(false);
        setProfileFetchFailed(false);
        resetUser();
      }

      if (isActive) {
        setLoading(false);
      }
    };

    const safetyTimeout = setTimeout(() => {
      setLoading((current) => {
        if (current) {
          logger.warn('Auth loading safety timeout triggered after 10s', { component: 'useAuth' });
        }
        return false;
      });
    }, 10_000);

    const bootstrapAuth = async () => {
      try {
        const { data: { session: initialSession }, error } = await supabase.auth.getSession();
        
        // If session restoration fails, clear stale local auth state.
        // U-17: scope 'local' — a defensive cleanup must never revoke other devices' sessions
        if (error) {
          logger.warn('Failed to restore session, clearing local auth', { component: 'useAuth', error });
          await supabase.auth.signOut({ scope: 'local' });
          if (isActive) setLoading(false);
          return;
        }
        
        await applySessionState(initialSession, 'bootstrap');
      } catch (err) {
        logger.warn('Failed to bootstrap auth session', { component: 'useAuth', err });
        // Clear potentially corrupted local state (local scope only — see U-17 above)
        try { await supabase.auth.signOut({ scope: 'local' }); } catch { /* ignore */ }
        if (isActive) setLoading(false);
      }
    };

    void bootstrapAuth();

    const { data: { subscription: authSubscription } } = supabase.auth.onAuthStateChange(
      (event, nextSession) => {
        if (event === 'TOKEN_REFRESHED' && !nextSession) {
          logger.warn('Token refresh failed, clearing stale session', { component: 'useAuth' });
          // Clear stale local storage immediately to stop retry loops
          if (SUPABASE_AUTH_STORAGE_KEY) {
            localStorage.removeItem(SUPABASE_AUTH_STORAGE_KEY);
          }
          setUser(null);
          setSession(null);
          setLoading(false);
          lastFetchedRef.current = null;
          setProfile(null);
          setRole(null);
          setRoles([]);
          setIsClubManager(false);
          setIsAcademyManager(false);
          setSubscription(null);
          setProfileReady(false);
          setProfileFetchFailed(false);
          return;
        }

        void applySessionState(nextSession, 'listener', event);
      }
    );

    return () => {
      isActive = false;
      clearTimeout(safetyTimeout);
      authSubscription.unsubscribe();
    };
  }, []);

  // Deferred: fetch subscription in background after auth resolves (non-blocking)
  useEffect(() => {
    if (role === 'trainer' && session?.access_token) {
      fetchSubscription();
    }
  }, [role, session?.access_token, fetchSubscription]);

  // Periodic subscription refresh for trainers (every 5 minutes)
  useEffect(() => {
    if (role !== 'trainer' || !session?.access_token) return;

    const interval = setInterval(() => {
      fetchSubscription();
    }, 5 * 60 * 1000);

    return () => clearInterval(interval);
  }, [role, session?.access_token, fetchSubscription]);


  return (
    <AuthContext.Provider value={{ 
      user, 
      session, 
      profile, 
      role,
      roles,
      isClubManager,
      isAcademyManager,
      subscription,
      loading, 
      profileReady,
      profileFetchFailed,
      refreshAuth,
      refreshSubscription,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
