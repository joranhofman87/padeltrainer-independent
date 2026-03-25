import { useEffect, useState, useRef, createContext, useContext, ReactNode, useCallback } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabaseClient';
import { getUserRole, getUserRoles, getProfile, UserRole, UserProfile } from '@/lib/auth';
import { SubscriptionInfo, SubscriptionTier } from '@/lib/subscription';
import { isUserClubManager } from '@/lib/club';
import { logger } from '@/lib/logger';
import { isUserAcademyManager } from '@/lib/academy';
import { identifyUser, resetUser } from '@/lib/tracking';
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
  refreshAuth: () => Promise<void>;
  refreshSubscription: () => Promise<void>;
}

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
  const lastFetchedRef = useRef<string | null>(null);

  const fetchUserData = async (userId: string) => {
    try {
      const [userRoles, userProfile, clubManagerStatus, academyManagerStatus] = await Promise.all([
        getUserRoles(userId),
        getProfile(userId),
        isUserClubManager(userId),
        isUserAcademyManager(userId),
      ]);
      
      // Determine primary role based on priority: admin > trainer > club > player
      const primaryRole = userRoles.includes('admin') ? 'admin'
        : userRoles.includes('trainer') ? 'trainer'
        : userRoles.includes('club') ? 'club'
        : userRoles.includes('player') ? 'player'
        : null;
      
      setRoles(userRoles);
      setRole(primaryRole);
      setIsClubManager(clubManagerStatus);
      setIsAcademyManager(academyManagerStatus);
      setProfile(userProfile);

      // Apply saved language preference
      if (userProfile?.preferred_language && userProfile.preferred_language !== i18n.language) {
        i18n.changeLanguage(userProfile.preferred_language);
      }

      // Link anonymous browsing history to this user in PostHog
      identifyUser(userId, {
        role: primaryRole,
        email: userProfile?.email ?? null,
        created_at: userProfile?.created_at ?? null,
      });
    } catch (err) {
      logger.error('Failed to fetch user data', err as Error, { component: 'useAuth' });
    }
  };

  const fetchSubscription = useCallback(async () => {
    if (!session?.access_token) {
      setSubscription(null);
      return;
    }

    try {
      const { data, error } = await supabase.functions.invoke('check-stripe-subscription', {
        body: { type: 'trainer' },
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });

      if (error) {
        logger.error('Error fetching subscription', error as Error, { component: 'useAuth' });
        setSubscription({
          isSubscribed: false,
          tier: 'trial',
          subscriptionEnd: null,
          trialEndsAt: null,
          isInTrial: false,
          isPublic: false,
        });
        return;
      }

      const tier = data.tier || 'trial';
      
      setSubscription({
        isSubscribed: data.subscribed,
        tier: tier as SubscriptionTier,
        subscriptionEnd: data.endsAt || null,
        trialEndsAt: data.trialEndsAt || null,
        isInTrial: data.status === 'trialing',
        isPublic: data.isPublic ?? false,
      });
    } catch (err) {
      logger.error('Error fetching subscription', err as Error, { component: 'useAuth' });
      setSubscription({
        isSubscribed: false,
        tier: 'trial',
        subscriptionEnd: null,
        trialEndsAt: null,
        isInTrial: false,
        isPublic: false,
      });
    }
  }, [session?.access_token]);

  const refreshAuth = async () => {
    if (user) {
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

        await Promise.race([
          fetchUserData(nextSession.user.id),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);

        if (
          source === 'listener' &&
          !sessionStorage.getItem(welcomeEmailsKey) &&
          nextSession.user.email_confirmed_at &&
          (event === 'SIGNED_IN' || event === 'USER_UPDATED')
        ) {
          sessionStorage.setItem(welcomeEmailsKey, '1');
          requestIdleCallback(() => {
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
        resetUser();
      }

      if (isActive) {
        setLoading(false);
      }
    };

    const safetyTimeout = setTimeout(() => {
      setLoading((current) => {
        if (current) {
          logger.warn('Auth loading safety timeout triggered after 5s', { component: 'useAuth' });
        }
        return false;
      });
    }, 5_000);

    const bootstrapAuth = async () => {
      try {
        const { data: { session: initialSession } } = await supabase.auth.getSession();
        await applySessionState(initialSession, 'bootstrap');
      } catch (err) {
        logger.warn('Failed to bootstrap auth session', { component: 'useAuth', err });
        if (isActive) setLoading(false);
      }
    };

    void bootstrapAuth();

    const { data: { subscription: authSubscription } } = supabase.auth.onAuthStateChange(
      (event, nextSession) => {
        if (event === 'TOKEN_REFRESHED' && !nextSession) {
          logger.warn('Token refresh failed, signing out', { component: 'useAuth' });
          setLoading(false);
          void supabase.auth.signOut();
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
