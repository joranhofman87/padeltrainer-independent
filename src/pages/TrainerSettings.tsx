import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft, Crown, User, CalendarSync, Bell, ClipboardCheck, Eye, EyeOff, AlertTriangle, FileText, Gamepad2, Building2, Globe, GraduationCap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DeleteAccountDialog } from '@/components/settings/DeleteAccountDialog';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { supabase } from '@/lib/supabaseClient';
import { toast } from 'sonner';
import { getTrialDaysRemaining, canBeVisible } from '@/lib/subscription';
import { isTrainerInPaidAcademy, getTrainerAcademy } from '@/lib/academy';
import { logger } from '@/lib/logger';

export default function TrainerSettings() {
  const { user, role, roles, loading, subscription, refreshSubscription, session, refreshAuth } = useAuth();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation('trainer');
  const [isPublic, setIsPublic] = useState(false);
  const [updatingVisibility, setUpdatingVisibility] = useState(false);
  const [inPaidAcademy, setInPaidAcademy] = useState(false);
  const [hasAcademy, setHasAcademy] = useState(false);
  const [playerModeEnabled, setPlayerModeEnabled] = useState(false);
  const [updatingPlayerMode, setUpdatingPlayerMode] = useState(false);

  // Auth is now handled by TrainerLayout

  // Sync isPublic with subscription data
  useEffect(() => {
    if (subscription) {
      setIsPublic(subscription.isPublic);
    }
  }, [subscription]);

  // Sync player mode with roles
  useEffect(() => {
    setPlayerModeEnabled(roles.includes('player'));
  }, [roles]);

  // Check academy membership
  useEffect(() => {
    const checkAcademy = async () => {
      if (user) {
        const { data: trainerProfile } = await supabase
          .from('trainer_profiles')
          .select('id')
          .eq('user_id', user.id)
          .maybeSingle();
        if (trainerProfile) {
          const academy = await getTrainerAcademy(trainerProfile.id);
          setHasAcademy(!!academy);
        }
      }
      if (!subscription?.isSubscribed && user) {
        // Only check if trainer doesn't have their own paid subscription
        const { data: trainerProfile } = await supabase
          .from('trainer_profiles')
          .select('id')
          .eq('user_id', user.id)
          .maybeSingle();
        if (trainerProfile) {
          const result = await isTrainerInPaidAcademy(trainerProfile.id);
          setInPaidAcademy(result);
        }
      }
    };
    checkAcademy();
  }, [user, subscription]);

  const handleVisibilityToggle = async (checked: boolean) => {
    if (!user) return;

    // Check if trainer can be visible (paid subscription or paid academy)
    if (checked && subscription && !canBeVisible(subscription) && !inPaidAcademy) {
      toast.error(t('settings.visibilityRequiresSubscription', 'You need an active subscription to be visible'));
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

      // Slack notification when profile goes public
      if (checked) {
        try {
          await supabase.functions.invoke('slack-notify', {
            body: {
              event: 'profile_published',
              data: {
                name: user?.user_metadata?.full_name || 'Unknown',
                email: user?.email || '',
              },
            },
          });
        } catch (slackErr) {
          logger.warn('Slack notification failed (non-fatal)', { component: 'TrainerSettings' });
        }
      }

      toast.success(checked 
        ? t('settings.visibilityOn', 'Your profile is now visible to players')
        : t('settings.visibilityOff', 'Your profile is now hidden')
      );
    } catch (error) {
      logger.error('Error updating visibility', error as Error, { component: 'TrainerSettings' });
      toast.error(t('common:error', 'Something went wrong'));
    } finally {
      setUpdatingVisibility(false);
    }
  };

  const handlePlayerModeToggle = async (checked: boolean) => {
    if (!session?.access_token) return;

    setUpdatingPlayerMode(true);
    try {
      const { data, error } = await supabase.functions.invoke('toggle-player-role', {
        body: { enable: checked },
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });

      if (error) throw error;

      setPlayerModeEnabled(checked);
      await refreshAuth();
      toast.success(checked
        ? t('settings.playerModeEnabled', 'Player mode enabled — you can now access the player dashboard')
        : t('settings.playerModeDisabled', 'Player mode disabled')
      );
    } catch (error) {
      logger.error('Error toggling player mode', error as Error, { component: 'TrainerSettings' });
      toast.error(t('common:error', 'Something went wrong'));
    } finally {
      setUpdatingPlayerMode(false);
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
  const canToggleVisibility = subscription ? (canBeVisible(subscription) || inPaidAcademy) : false;
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
    ...(!hasAcademy ? [{
      title: t('settings.subscription'),
      description: t('settings.subscriptionDescription'),
      icon: Crown,
      route: '/trainer/subscription',
      iconBg: 'bg-purple-500/10',
      iconColor: 'text-purple-600',
    }] : []),
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
    {
      title: t('terms.title', 'General Terms'),
      description: t('terms.settingsDescription', 'Manage your general terms and conditions'),
      icon: FileText,
      route: '/app/trainer/terms',
      iconBg: 'bg-amber-500/10',
      iconColor: 'text-amber-600',
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
                    <Eye className={`h-5 w-5 text-green-600`} />
                  ) : (
                    <EyeOff className="h-5 w-5 text-muted-foreground" />
                  )}
                </div>
                <div className="flex-1">
                  <CardTitle className="text-lg">{t('settings.marketplaceVisibility', 'Marketplace visibility')}</CardTitle>
                  <CardDescription>
                    {isPublic
                      ? t('settings.visibleHelper', 'Visible — players can find you and request lessons')
                      : t('settings.hiddenHelper', "Hidden — you won't appear in search and players can't book you")}
                  </CardDescription>
                </div>
                <Switch
                  checked={isPublic}
                  onCheckedChange={handleVisibilityToggle}
                  disabled={updatingVisibility || !canToggleVisibility}
                />
              </div>
            </CardHeader>
            <CardContent className="pt-0 space-y-2">
              <p className="text-xs text-muted-foreground">
                {t('settings.visibilitySafety', 'You can switch this off anytime.')}
              </p>
              {visibilityStatus && (
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
              )}
            </CardContent>
          </Card>
        </div>

        {/* Academy Info */}
        {hasAcademy && (
          <div className="max-w-4xl mb-8">
            <Alert>
              <Building2 className="h-4 w-4" />
              <AlertDescription>
                {t('settings.managedByAcademy', 'Your subscription and payments are managed by your academy.')}
              </AlertDescription>
            </Alert>
          </div>
        )}

        {/* Player Mode Section */}
        <div className="max-w-4xl mb-8">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${playerModeEnabled ? 'bg-blue-500/10' : 'bg-muted'}`}>
                  <Gamepad2 className={`h-5 w-5 ${playerModeEnabled ? 'text-blue-600' : 'text-muted-foreground'}`} />
                </div>
                <div className="flex-1">
                  <CardTitle className="text-lg">{t('settings.playerMode', 'Player mode')}</CardTitle>
                  <CardDescription>
                    {t('settings.playerModeDescription', 'Access the player dashboard to book lessons with other trainers')}
                  </CardDescription>
                </div>
                <Switch
                  checked={playerModeEnabled}
                  onCheckedChange={handlePlayerModeToggle}
                  disabled={updatingPlayerMode}
                />
              </div>
            </CardHeader>
          </Card>
        </div>

        {/* Start an Academy */}
        {!hasAcademy && (
          <div className="max-w-4xl mb-8">
            <Card
              className="cursor-pointer hover:shadow-lg transition-shadow hover:border-emerald-500/50"
              onClick={() => navigate('/app/onboarding/academy')}
            >
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-emerald-500/10">
                    <GraduationCap className="h-5 w-5 text-emerald-600" />
                  </div>
                  <div className="flex-1">
                    <CardTitle className="text-lg">{t('settings.startAcademy')}</CardTitle>
                    <CardDescription>{t('settings.startAcademyDescription')}</CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>
          </div>
        )}

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

        {/* Language Setting */}
        <div className="max-w-4xl mt-8">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-indigo-500/10">
                  <Globe className="h-5 w-5 text-indigo-600" />
                </div>
                <div className="flex-1">
                  <CardTitle className="text-lg">{t('settings.language', 'Language')}</CardTitle>
                  <CardDescription>{t('settings.languageDescription', 'Choose your preferred language for the app')}</CardDescription>
                </div>
                <Select
                  value={i18n.language}
                  onValueChange={async (value) => {
                    i18n.changeLanguage(value);
                    if (user) {
                      await supabase.from('profiles').update({ preferred_language: value } as any).eq('user_id', user.id);
                    }
                  }}
                >
                  <SelectTrigger className="w-[160px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="nl">🇳🇱 Nederlands</SelectItem>
                    <SelectItem value="en">🇬🇧 English</SelectItem>
                    <SelectItem value="es">🇪🇸 Español</SelectItem>
                    <SelectItem value="de">🇩🇪 Deutsch</SelectItem>
                    <SelectItem value="fr">🇫🇷 Français</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
          </Card>
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
