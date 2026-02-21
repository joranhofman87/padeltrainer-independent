import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft, User, CalendarSync, Bell, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DeleteAccountDialog } from '@/components/settings/DeleteAccountDialog';
import { supabase } from '@/lib/supabaseClient';

export default function PlayerSettings() {
  const { loading, user } = useAuth();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation('player');

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
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
      title: t('nav.calendarSync'),
      description: t('settings.calendarSyncDescription', 'Sync your bookings with external calendars'),
      icon: CalendarSync,
      route: '/player/settings/calendar',
      iconBg: 'bg-blue-500/10',
      iconColor: 'text-blue-600',
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
    <>
      {/* Sub-page Header */}
      <div className="border-b bg-background/60">
        <div className="container mx-auto px-4 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/app/player')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-xl font-bold">{t('settings.title', 'Settings')}</h1>
            <p className="text-sm text-muted-foreground">{t('settings.subtitle', 'Manage your account settings')}</p>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
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
        <div className="max-w-4xl mt-6">
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
