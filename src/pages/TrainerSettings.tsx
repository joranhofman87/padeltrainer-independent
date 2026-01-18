import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft, Crown, User, CalendarSync, Bell, ClipboardCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export default function TrainerSettings() {
  const { user, role, loading } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation('trainer');

  useEffect(() => {
    if (!loading) {
      if (!user) {
        navigate('/auth');
      } else if (role !== 'trainer') {
        navigate('/player');
      }
    }
  }, [user, role, loading, navigate]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  const settingsItems = [
    {
      title: t('settings.subscription'),
      description: t('settings.subscriptionDescription'),
      icon: Crown,
      route: '/subscription',
      iconBg: 'bg-purple-500/10',
      iconColor: 'text-purple-600',
    },
    {
      title: t('settings.profile'),
      description: t('settings.profileDescription'),
      icon: User,
      route: '/profile/edit',
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
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/trainer')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-xl font-bold">{t('settings.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('settings.subtitle')}</p>
          </div>
        </div>
      </header>

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
      </main>
    </div>
  );
}
