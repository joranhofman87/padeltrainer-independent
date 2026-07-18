import { useEffect, useRef } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { buildPersonTrackingId, buildPseudonymousTrackingEmail } from '@/lib/trackingPrivacy';

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
          logger.error('Failed to get referral token', error instanceof Error ? error : new Error(String(error)), { component: 'ReferralWidget' });
          return;
        }

        // Load the referral widget with auth
        if (typeof window.gr === 'function') {
          // Send the pseudonymous PERSON UID to Reditus, never the real email/name.
          // The widget requires an email-shaped field, so we pass a non-deliverable
          // person:<id> alias; the auth_token above is the real bearer of identity.
          const personUid = profile.id;
          window.gr('loadReferralWidget', {
            product_id: data.product_id,
            auth_token: data.token,
            user_details: {
              email: buildPseudonymousTrackingEmail(personUid),
              name: buildPersonTrackingId(personUid),
            },
          });
        }
      } catch (err) {
        logger.error('Error initializing referral widget', err instanceof Error ? err : new Error(String(err)), { component: 'ReferralWidget' });
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
