import { useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import {
  NOTIFICATION_SETTINGS_ENTRY_PATH,
  notificationSettingsPathFor,
} from '@/lib/notificationSettingsRoute';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { QueryErrorState } from '@/components/ui/QueryErrorState';
import { FullPageLoader } from '@/components/ui/page-spinner';
import { Bell } from 'lucide-react';

/**
 * `/app/settings/notifications` — the ROLE-AGNOSTIC entry to notification settings.
 *
 * WHY THIS EXISTS. Outbound email footers deep-link to notification settings, and without this
 * they must guess the recipient's surface from the EMAIL TYPE. That guess is wrong for anyone
 * holding more than one role: an academy manager sent to the trainer path is bounced by
 * TrainerLayout to the player dashboard, and the deep link is silently discarded. A sender cannot
 * know which surface a recipient belongs to; the app can. So senders link here and this resolves it.
 *
 * IT IS MOUNTED OUTSIDE THE ROLE LAYOUTS on purpose. Mounting it under one would re-create the
 * bug: that layout's guard bounces every role it does not recognise, which is the exact failure
 * this route exists to prevent.
 */
export default function NotificationSettingsEntry() {
  const { user, roles, isAcademyManager, loading, profileReady, profileFetchFailed, refreshAuth } =
    useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation('common');

  // Same shape as the role layouts: wait for the ROLES, not merely the session. Forwarding on a
  // half-resolved auth state would send a trainer to the player surface and strand them there.
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

  // U-12: empty roles after a FAILED fetch means "couldn't load", not "this account has no
  // notifications". Claiming the latter would be a lie about the account, and a dead end at the
  // end of an email link. Offer the retry instead.
  if (roles.length === 0 && profileFetchFailed) {
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

  const target = notificationSettingsPathFor({ isAcademyManager, roles });
  // `replace` so the entry never sits in history: Back from the settings page should return where
  // the person came from, not bounce forward through the redirect again.
  if (target) return <Navigate to={target} replace />;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50/80 p-4">
      <Card className="w-full max-w-md" data-testid="notification-settings-unavailable">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bell className="h-5 w-5" />
            {t('notifications.unavailableTitle')}
          </CardTitle>
          <CardDescription>{t('notifications.unavailableBody')}</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
