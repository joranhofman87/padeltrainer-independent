import { useEffect, useState, createContext, useContext, ReactNode, useCallback } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { getUserRole, getUserRoles, getProfile, UserRole, UserProfile } from '@/lib/auth';
import { SubscriptionInfo, SubscriptionTier } from '@/lib/subscription';
import { isUserClubManager } from '@/lib/club';
import { logger } from '@/lib/logger';
import { isUserAcademyManager } from '@/lib/academy';

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

  const fetchUserData = async (userId: string) => {
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
  };

  const fetchSubscription = useCallback(async () => {
    if (!session?.access_token) {
      setSubscription(null);
      return;
    }

    try {
      // Use check-mollie-subscription with type: "trainer" instead of legacy check-trainer-subscription
      const { data, error } = await supabase.functions.invoke('check-mollie-subscription', {
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
          productId: null,
          subscriptionEnd: null,
          trialEndsAt: null,
          isInTrial: false,
          isPublic: false,
        });
        return;
      }

      // Use tier directly from API response (database-driven) instead of Stripe product ID mapping
      const tier = data.tier || 'trial';
      
      setSubscription({
        isSubscribed: data.subscribed,
        tier: tier as SubscriptionTier,
        productId: null, // No longer using Stripe product IDs
        subscriptionEnd: data.endsAt || null,
        trialEndsAt: data.trialEndsAt || null,
        isInTrial: data.status === 'trialing',
        isPublic: data.subscribed || data.status === 'trialing',
      });
    } catch (err) {
      logger.error('Error fetching subscription', err as Error, { component: 'useAuth' });
      setSubscription({
        isSubscribed: false,
        tier: 'trial',
        productId: null,
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
    // Track if we've already triggered welcome emails for this session
    let hasTriggeredWelcomeEmails = false;

    // Set up auth state listener FIRST
    const { data: { subscription: authSubscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        // Handle token refresh failures - sign out to clear invalid session
        if (event === 'TOKEN_REFRESHED' && !session) {
          logger.warn('Token refresh failed, signing out', { component: 'useAuth' });
          await supabase.auth.signOut();
          return;
        }

        setSession(session);
        setUser(session?.user ?? null);
        
        if (session?.user) {
          // Await fetchUserData to ensure role is loaded before setting loading to false
          await fetchUserData(session.user.id);

          // Trigger welcome emails when user signs in with confirmed email
          // This handles the case where user just confirmed their email
          if (
            !hasTriggeredWelcomeEmails &&
            session.user.email_confirmed_at &&
            (event === 'SIGNED_IN' || event === 'USER_UPDATED')
          ) {
            hasTriggeredWelcomeEmails = true;
            // Fire and forget - don't block auth flow
            supabase.functions.invoke('trigger-welcome-emails', {
              headers: {
                Authorization: `Bearer ${session.access_token}`,
              },
            }).then(({ error }) => {
              if (error) {
                logger.warn('Failed to trigger welcome emails', { component: 'useAuth', error });
              }
            });
          }
        } else {
          setProfile(null);
          setRole(null);
          setRoles([]);
          setIsClubManager(false);
          setIsAcademyManager(false);
          setSubscription(null);
        }
        setLoading(false);
      }
    );

    // THEN check for existing session
    supabase.auth.getSession().then(async ({ data: { session }, error }) => {
      // If there's an error getting the session, sign out to clear corrupted state
      if (error) {
        logger.warn('Failed to get session, signing out', { component: 'useAuth', error });
        await supabase.auth.signOut();
        setLoading(false);
        return;
      }

      setSession(session);
      setUser(session?.user ?? null);
      
      if (session?.user) {
        await fetchUserData(session.user.id);
      }
      setLoading(false);
    }).catch(async (error) => {
      logger.error('Session retrieval error', error as Error, { component: 'useAuth' });
      await supabase.auth.signOut();
      setLoading(false);
    });

    return () => authSubscription.unsubscribe();
  }, []);

  // Fetch subscription when role changes to trainer
  useEffect(() => {
    if (role === 'trainer' && session?.access_token) {
      fetchSubscription();
    }
  }, [role, session?.access_token, fetchSubscription]);

  // Set up periodic subscription refresh for trainers (every 60 seconds)
  useEffect(() => {
    if (role !== 'trainer' || !session?.access_token) return;

    const interval = setInterval(() => {
      fetchSubscription();
    }, 60000);

    return () => clearInterval(interval);
  }, [role, session?.access_token, fetchSubscription]);

  // Periodically validate session is still valid (every 5 minutes)
  useEffect(() => {
    const interval = setInterval(async () => {
      if (!session) return;
      
      const { error } = await supabase.auth.getUser();
      if (error?.message?.includes('Invalid Refresh Token') || 
          error?.message?.includes('Refresh Token Not Found')) {
        logger.warn('Invalid session detected, signing out', { component: 'useAuth' });
        await supabase.auth.signOut();
      }
    }, 300000); // 5 minutes

    return () => clearInterval(interval);
  }, [session]);

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
