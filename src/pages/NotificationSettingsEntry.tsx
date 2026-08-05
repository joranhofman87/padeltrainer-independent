import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { NOTIFICATION_SETTINGS_ENTRY_PATH } from '@/lib/notificationSettingsRoute';
import NotificationSettings from '@/pages/NotificationSettings';
import { QueryErrorState } from '@/components/ui/QueryErrorState';
import { FullPageLoader } from '@/components/ui/page-spinner';

/**
 * `/app/settings/notifications` — the ROLE-AGNOSTIC entry to notification settings.
 *
 * WHY THIS EXISTS. Outbound email footers deep-link to notification settings, and without this
 * they must guess the recipient's surface from the EMAIL TYPE. That guess is wrong for anyone
 * holding more than one role: an academy manager sent to the trainer path is bounced by
 * TrainerLayout to the player dashboard, and the deep link is silently discarded. A sender cannot
 * know which surface a recipient belongs to; the app can.
 *
 * IT RENDERS THE SETTINGS PAGE — IT DOES NOT FORWARD TO A ROLE ROUTE. Forwarding was the first
 * design and it was wrong: the role layouts guard far more than role. AcademyLayout redirects an
 * expired academy to `/app/academy/subscription`; TrainerLayout redirects an incomplete onboarding
 * to `/app/onboarding/trainer`, and an expired solo trainer to subscription. Each fires on the
 * settings path too, so forwarding only moved the bounce one hop later — and the people it
 * stranded are precisely the ones most likely to be unsubscribing. Rendering here means no
 * downstream guard, present or future, can stand between a recipient and turning mail off.
 *
 * That is also why it is mounted OUTSIDE every role layout in `DomainRouter`: nested under one,
 * those same guards would apply and re-create the bug.
 */
export default function NotificationSettingsEntry() {
  const { user, loading, profileReady, profileFetchFailed, refreshAuth } = useAuth();
  const navigate = useNavigate();

  // Same predicate as the role layouts: wait for the profile, not merely the session.
  const authResolving = loading || (!!user && !profileReady);

  useEffect(() => {
    if (authResolving || user) return;
    // A footer link is usually opened in a fresh tab hours later, with no session. The role
    // layouts bounce to /app/auth and DROP the attempted location, so the person lands on a login
    // form and then a dashboard — never at the setting they clicked through to change. Carry the
    // destination so Auth can restore it after login.
    navigate(`/app/auth?redirect=${encodeURIComponent(NOTIFICATION_SETTINGS_ENTRY_PATH)}`, {
      replace: true,
    });
  }, [authResolving, user, navigate]);

  if (authResolving || !user) return <FullPageLoader />;

  // ANY aggregate fetch failure disqualifies this page, not only one that left `roles` empty.
  // `useAuth` publishes PARTIAL results on its final attempt: a failed academy-manager lookup
  // beside a successful roles lookup yields `isAcademyManager === false` with real roles, and a
  // failed fetch after an account switch keeps the PREVIOUS account's roles (neither is cleared on
  // switch). Both feed the settings page's staff test, so rendering would quietly show a trainer
  // or manager the player-only list — a wrong answer that looks like a complete one.
  if (profileFetchFailed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50/80 p-4">
        <QueryErrorState
          className="w-full max-w-md"
          onRetry={() => {
            void refreshAuth();
          }}
        />
      </div>
    );
  }

  return <NotificationSettings />;
}
