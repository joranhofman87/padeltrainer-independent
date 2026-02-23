import { useEffect, useRef } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';

declare global {
  interface Window {
    gr: (...args: any[]) => void;
    referralWidget: { show: () => void };
  }
}

export function ReferralWidget() {
  const { user, profile } = useAuth();
  const initialized = useRef(false);

  useEffect(() => {
    if (!user || !profile || initialized.current) return;
    initialized.current = true;

    const init = async () => {
      try {
        const { data, error } = await supabase.functions.invoke('reditus-referral-token');
        if (error || !data?.token) {
          console.error('Failed to get referral token:', error);
          return;
        }

        // Load the referral widget with auth
        if (typeof window.gr === 'function') {
          window.gr('loadReferralWidget', {
            product_id: data.product_id,
            auth_token: data.token,
            user_details: {
              email: profile.email,
              name: profile.full_name || undefined,
            },
          });
        }
      } catch (err) {
        console.error('Error initializing referral widget:', err);
      }
    };

    init();
  }, [user, profile]);

  return null;
}

export function showReferralWidget() {
  if (typeof window !== 'undefined' && window.referralWidget) {
    window.referralWidget.show();
  }
}
