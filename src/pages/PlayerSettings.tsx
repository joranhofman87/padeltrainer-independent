import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft, User, Bell, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DeleteAccountDialog } from '@/components/settings/DeleteAccountDialog';
import { supabase } from '@/lib/supabaseClient';
import { AppPage, surfaceCardClass } from '@/components/ui/app-page';
import { PageHeader } from '@/components/ui/page-header';
import { cn } from '@/lib/utils';

export default function PlayerSettings() {
  const { loading, user } = useAuth();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation('player');

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    );
  }

  const settingsItems = [
    {
      title: t('nav.editProfile'),
      description: t('settings.profileDescription', 'Update your profile information and preferences'),
      icon: User,
      route: '/player/profile',
      iconBg: 'bg-gray-500/10',
      iconColor: 'text-gray-600',
    },
    {
      title: t('nav.notifications'),
      description: t('settings.notificationsDescription', 'Manage your notification preferences'),
      icon: Bell,
      route: '/player/settings/notifications',
      iconBg: 'bg-orange-500/10',
      iconColor: 'text-orange-600',
    },
  ];

  return (
    <AppPage width="form" as="main" data-testid="page-player-settings">
      <PageHeader
        title={t('settings.title', 'Settings')}
        description={t('settings.subtitle', 'Manage your account settings')}
        actions={
          <Button variant="ghost" size="icon" aria-label="Go back" onClick={() => navigate('/app/player')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
        }
      />

      <div className="grid gap-4 md:grid-cols-2">
          {settingsItems.map((item) => (
            <Card
              key={item.route}
              className={cn(surfaceCardClass(), 'cursor-pointer transition-colors hover:bg-muted/30')}
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

        <div className="mt-6">
          <Card className={surfaceCardClass()}>
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
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
          </Card>
        </div>

        <div className="mt-8 border-t border-destructive/20 pt-6">
          <h3 className="text-lg font-semibold text-destructive mb-4">{t('settings.dangerZone', 'Danger Zone')}</h3>
          <DeleteAccountDialog />
        </div>
    </AppPage>
  );
}
