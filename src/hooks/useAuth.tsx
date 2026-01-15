import { useEffect, useState, createContext, useContext, ReactNode, useCallback } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { getUserRole, getProfile, UserRole, UserProfile } from '@/lib/auth';
import { SubscriptionInfo, getTierFromProductId } from '@/lib/subscription';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  profile: UserProfile | null;
  role: UserRole | null;
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
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchUserData = async (userId: string) => {
    const [userRole, userProfile] = await Promise.all([
      getUserRole(userId),
      getProfile(userId),
    ]);
    setRole(userRole);
    setProfile(userProfile);
  };

  const fetchSubscription = useCallback(async () => {
    if (!session?.access_token) {
      setSubscription(null);
      return;
    }

    try {
      const { data, error } = await supabase.functions.invoke('check-trainer-subscription', {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });

      if (error) {
        console.error('Error fetching subscription:', error);
        setSubscription({
          isSubscribed: false,
          tier: 'starter',
          productId: null,
          subscriptionEnd: null,
        });
        return;
      }

      setSubscription({
        isSubscribed: data.subscribed,
        tier: data.tier || getTierFromProductId(data.product_id),
        productId: data.product_id,
        subscriptionEnd: data.subscription_end,
      });
    } catch (err) {
      console.error('Error fetching subscription:', err);
      setSubscription({
        isSubscribed: false,
        tier: 'starter',
        productId: null,
        subscriptionEnd: null,
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
    // Set up auth state listener FIRST
    const { data: { subscription: authSubscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        setSession(session);
        setUser(session?.user ?? null);
        
        if (session?.user) {
          // Use setTimeout to avoid potential deadlock with Supabase client
          setTimeout(() => {
            fetchUserData(session.user.id);
          }, 0);
        } else {
          setProfile(null);
          setRole(null);
          setSubscription(null);
        }
        setLoading(false);
      }
    );

    // THEN check for existing session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      
      if (session?.user) {
        fetchUserData(session.user.id);
      }
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

  return (
    <AuthContext.Provider value={{ 
      user, 
      session, 
      profile, 
      role, 
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
