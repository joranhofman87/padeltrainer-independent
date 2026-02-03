import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft, Crown, User, CalendarSync, Bell, ClipboardCheck, Eye, EyeOff, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DeleteAccountDialog } from '@/components/settings/DeleteAccountDialog';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { getTrialDaysRemaining, canBeVisible } from '@/lib/subscription';

export default function TrainerSettings() {
  const { user, role, loading, subscription, refreshSubscription } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation('trainer');
  const [isPublic, setIsPublic] = useState(false);
  const [updatingVisibility, setUpdatingVisibility] = useState(false);

  // Auth is now handled by TrainerLayout

  // Sync isPublic with subscription data
  useEffect(() => {
    if (subscription) {
      setIsPublic(subscription.isPublic);
    }
  }, [subscription]);

  const handleVisibilityToggle = async (checked: boolean) => {
    if (!user) return;

    // Check if trainer can be visible
    if (checked && subscription && !canBeVisible(subscription)) {
      toast.error(t('settings.visibilityRequiresSubscription', 'You need an active subscription or trial to be visible'));
      return;
    }

    setUpdatingVisibility(true);
    try {
      const { error } = await supabase
        .from('trainer_profiles')
        .update({ is_public: checked })
        .eq('user_id', user.id);

      if (error) throw error;

      setIsPublic(checked);
      await refreshSubscription();
      toast.success(checked 
        ? t('settings.visibilityOn', 'Your profile is now visible to players')
        : t('settings.visibilityOff', 'Your profile is now hidden')
      );
    } catch (error) {
      console.error('Error updating visibility:', error);
      toast.error(t('common:error', 'Something went wrong'));
    } finally {
      setUpdatingVisibility(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  const trialDaysRemaining = subscription?.trialEndsAt 
    ? getTrialDaysRemaining(subscription.trialEndsAt) 
    : 0;
  const canToggleVisibility = subscription ? canBeVisible(subscription) : false;
  const isTrialActive = subscription?.isInTrial && !subscription?.isSubscribed;
  const isSubscribed = subscription?.isSubscribed;

  const getVisibilityStatus = () => {
    if (!canToggleVisibility) {
      return {
        message: t('settings.trialExpiredMessage', 'Your trial has ended. Subscribe to be visible to players.'),
        type: 'warning' as const,
      };
    }
    if (isPublic && isTrialActive) {
      return {
        message: t('settings.visibleTrialMessage', 'Your profile is visible. {{days}} days left in your trial.', { days: trialDaysRemaining }),
        type: 'info' as const,
      };
    }
    if (isPublic && isSubscribed) {
      return {
        message: t('settings.visibleSubscribedMessage', 'Your profile is live and visible to players.'),
        type: 'success' as const,
      };
    }
    if (!isPublic && canToggleVisibility) {
      return {
        message: t('settings.hiddenMessage', 'Your profile is hidden. Toggle to go live.'),
        type: 'info' as const,
      };
    }
    return null;
  };

  const visibilityStatus = getVisibilityStatus();

  const settingsItems = [
    {
      title: t('settings.subscription'),
      description: t('settings.subscriptionDescription'),
      icon: Crown,
      route: '/trainer/subscription',
      iconBg: 'bg-purple-500/10',
      iconColor: 'text-purple-600',
    },
    {
      title: t('settings.profile'),
      description: t('settings.profileDescription'),
      icon: User,
      route: '/trainer/profile',
      iconBg: 'bg-gray-500/10',
      iconColor: 'text-gray-600',
    },
    {
      title: t('bookingSettings.title'),
      description: t('bookingSettings.settingsDescription'),
      icon: ClipboardCheck,
      route: '/trainer/settings/bookings',
      iconBg: 'bg-green-500/10',
      iconColor: 'text-green-600',
    },
    {
      title: t('settings.calendarSync'),
      description: t('settings.calendarSyncDescription'),
      icon: CalendarSync,
      route: '/settings/calendar',
      iconBg: 'bg-blue-500/10',
      iconColor: 'text-blue-600',
    },
    {
      title: t('settings.notifications'),
      description: t('settings.notificationsDescription'),
      icon: Bell,
      route: '/settings/notifications',
      iconBg: 'bg-orange-500/10',
      iconColor: 'text-orange-600',
    },
  ];

  return (
    <>
      {/* Sub-page Header */}
      <div className="border-b bg-background/60">
        <div className="container mx-auto px-4 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/trainer')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-xl font-bold">{t('settings.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('settings.subtitle')}</p>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        {/* Profile Visibility Section */}
        <div className="max-w-4xl mb-8">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${isPublic ? 'bg-green-500/10' : 'bg-muted'}`}>
                  {isPublic ? (
                    <Eye className={`h-5 w-5 ${isPublic ? 'text-green-600' : 'text-muted-foreground'}`} />
                  ) : (
                    <EyeOff className="h-5 w-5 text-muted-foreground" />
                  )}
                </div>
                <div className="flex-1">
                  <CardTitle className="text-lg">{t('settings.profileVisibility', 'Profile Visibility')}</CardTitle>
                  <CardDescription>
                    {t('settings.profileVisibilityDescription', 'Control whether players can find you in search results')}
                  </CardDescription>
                </div>
                <Switch
                  checked={isPublic}
                  onCheckedChange={handleVisibilityToggle}
                  disabled={updatingVisibility || !canToggleVisibility}
                />
              </div>
            </CardHeader>
            {visibilityStatus && (
              <CardContent className="pt-0">
                <Alert variant={visibilityStatus.type === 'warning' ? 'destructive' : 'default'}>
                  {visibilityStatus.type === 'warning' && <AlertTriangle className="h-4 w-4" />}
                  <AlertDescription className="flex items-center justify-between">
                    <span>{visibilityStatus.message}</span>
                    {!canToggleVisibility && (
                      <Button size="sm" onClick={() => navigate('/subscription')}>
                        {t('settings.subscribe', 'Subscribe')}
                      </Button>
                    )}
                  </AlertDescription>
                </Alert>
              </CardContent>
            )}
          </Card>
        </div>

        <div className="grid md:grid-cols-2 gap-4 max-w-4xl">
          {settingsItems.map((item) => (
            <Card
              key={item.route}
              className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
              onClick={() => navigate(item.route)}
            >
              <CardHeader className="pb-2">
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-lg ${item.iconBg}`}>
                    <item.icon className={`h-5 w-5 ${item.iconColor}`} />
                  </div>
                  <CardTitle className="text-lg">{item.title}</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <CardDescription>{item.description}</CardDescription>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Danger Zone */}
        <div className="max-w-4xl mt-8 pt-6 border-t border-destructive/20">
          <h3 className="text-lg font-semibold text-destructive mb-4">{t('settings.dangerZone', 'Danger Zone')}</h3>
          <DeleteAccountDialog />
        </div>
      </main>
    </>
  );
}
