import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabaseClient';
import { ArrowLeft, Bell, Mail, Calendar, Star, Users, CreditCard, Clock, UserPlus } from 'lucide-react';

type Frequency = 'instant' | 'daily' | 'weekly' | 'off';

interface NotificationPrefs {
  // Player
  booking_confirmation: Frequency;
  booking_reminder: Frequency;
  open_slots_digest: Frequency;
  upcoming_sessions_digest: Frequency;
  payment_receipt: Frequency;
  waitlist_update: Frequency;
  // Trainer / Academy
  new_booking: Frequency;
  booking_cancelled: Frequency;
  new_follower: Frequency;
  new_player: Frequency;
  new_registration: Frequency;
  new_review: Frequency;
  upcoming_schedule_digest: Frequency;
  payment_received: Frequency;
}

const DEFAULT_PREFS: NotificationPrefs = {
  booking_confirmation: 'instant',
  booking_reminder: 'instant',
  open_slots_digest: 'weekly',
  upcoming_sessions_digest: 'daily',
  payment_receipt: 'instant',
  waitlist_update: 'instant',
  new_booking: 'instant',
  booking_cancelled: 'instant',
  new_follower: 'daily',
  new_player: 'daily',
  new_registration: 'instant',
  new_review: 'instant',
  upcoming_schedule_digest: 'daily',
  payment_received: 'instant',
};

interface NotificationItem {
  key: keyof NotificationPrefs;
  icon: React.ReactNode;
  allowedFrequencies?: Frequency[];
}

interface NotificationCategory {
  title: string;
  description: string;
  items: NotificationItem[];
}

function getPlayerCategories(t: (key: string) => string): NotificationCategory[] {
  return [
    {
      title: t('notifications.categories.bookings'),
      description: t('notifications.categories.bookingsDesc'),
      items: [
        { key: 'booking_confirmation', icon: <Calendar className="h-5 w-5 text-muted-foreground" /> },
        { key: 'booking_reminder', icon: <Bell className="h-5 w-5 text-muted-foreground" /> },
      ],
    },
    {
      title: t('notifications.categories.availability'),
      description: t('notifications.categories.availabilityDesc'),
      items: [
        { key: 'open_slots_digest', icon: <Clock className="h-5 w-5 text-muted-foreground" />, allowedFrequencies: ['daily', 'weekly', 'off'] },
      ],
    },
    {
      title: t('notifications.categories.schedule'),
      description: t('notifications.categories.scheduleDesc'),
      items: [
        { key: 'upcoming_sessions_digest', icon: <Calendar className="h-5 w-5 text-muted-foreground" />, allowedFrequencies: ['daily', 'weekly', 'off'] },
      ],
    },
    {
      title: t('notifications.categories.payments'),
      description: t('notifications.categories.paymentsDesc'),
      items: [
        { key: 'payment_receipt', icon: <CreditCard className="h-5 w-5 text-muted-foreground" /> },
      ],
    },
    {
      title: t('notifications.categories.waitlist'),
      description: t('notifications.categories.waitlistDesc'),
      items: [
        { key: 'waitlist_update', icon: <Users className="h-5 w-5 text-muted-foreground" /> },
      ],
    },
  ];
}

function getTrainerCategories(t: (key: string) => string): NotificationCategory[] {
  return [
    {
      title: t('notifications.categories.bookings'),
      description: t('notifications.categories.bookingsDescTrainer'),
      items: [
        { key: 'new_booking', icon: <Calendar className="h-5 w-5 text-muted-foreground" /> },
        { key: 'booking_cancelled', icon: <Bell className="h-5 w-5 text-muted-foreground" /> },
      ],
    },
    {
      title: t('notifications.categories.players'),
      description: t('notifications.categories.playersDesc'),
      items: [
        { key: 'new_follower', icon: <Users className="h-5 w-5 text-muted-foreground" /> },
        { key: 'new_player', icon: <UserPlus className="h-5 w-5 text-muted-foreground" /> },
      ],
    },
    {
      title: t('notifications.categories.registrations'),
      description: t('notifications.categories.registrationsDesc'),
      items: [
        { key: 'new_registration', icon: <Mail className="h-5 w-5 text-muted-foreground" /> },
      ],
    },
    {
      title: t('notifications.categories.reviews'),
      description: t('notifications.categories.reviewsDesc'),
      items: [
        { key: 'new_review', icon: <Star className="h-5 w-5 text-muted-foreground" /> },
      ],
    },
    {
      title: t('notifications.categories.schedule'),
      description: t('notifications.categories.scheduleDescTrainer'),
      items: [
        { key: 'upcoming_schedule_digest', icon: <Clock className="h-5 w-5 text-muted-foreground" />, allowedFrequencies: ['daily', 'weekly', 'off'] },
      ],
    },
    {
      title: t('notifications.categories.payments'),
      description: t('notifications.categories.paymentsDescTrainer'),
      items: [
        { key: 'payment_received', icon: <CreditCard className="h-5 w-5 text-muted-foreground" /> },
      ],
    },
  ];
}

export default function NotificationSettings() {
  const { user, role, isAcademyManager, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t } = useTranslation('common');

  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_PREFS);
  const [dataLoading, setDataLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const effectiveRole = isAcademyManager ? 'trainer' : role;

  useEffect(() => {
    if (!loading && !user) {
      navigate('/app/auth');
    }
  }, [user, loading, navigate]);

  useEffect(() => {
    if (user) {
      fetchPreferences();
    }
  }, [user]);

  const fetchPreferences = async () => {
    try {
      const { data, error } = await supabase
        .from('notification_preferences')
        .select('*')
        .eq('user_id', user!.id)
        .maybeSingle();

      if (error) throw error;
      if (data) {
        setPrefs((prev) => ({
          ...prev,
          ...Object.fromEntries(
            Object.keys(DEFAULT_PREFS)
              .filter((k) => data[k] !== undefined && data[k] !== null)
              .map((k) => [k, data[k]])
          ),
        }));
      }
    } catch (error: any) {
      console.error('Error fetching preferences:', error);
    } finally {
      setDataLoading(false);
    }
  };

  const savePreferences = useCallback(
    async (newPrefs: NotificationPrefs) => {
      setSaving(true);
      try {
        const { data: existing } = await supabase
          .from('notification_preferences')
          .select('id')
          .eq('user_id', user!.id)
          .maybeSingle();

        const payload = {
          booking_confirmation: newPrefs.booking_confirmation,
          booking_reminder: newPrefs.booking_reminder,
          open_slots_digest: newPrefs.open_slots_digest,
          upcoming_sessions_digest: newPrefs.upcoming_sessions_digest,
          payment_receipt: newPrefs.payment_receipt,
          waitlist_update: newPrefs.waitlist_update,
          new_booking: newPrefs.new_booking,
          booking_cancelled: newPrefs.booking_cancelled,
          new_follower: newPrefs.new_follower,
          new_player: newPrefs.new_player,
          new_registration: newPrefs.new_registration,
          new_review: newPrefs.new_review,
          upcoming_schedule_digest: newPrefs.upcoming_schedule_digest,
          payment_received: newPrefs.payment_received,
          updated_at: new Date().toISOString(),
        };

        if (existing) {
          const { error } = await supabase
            .from('notification_preferences')
            .update(payload)
            .eq('user_id', user!.id);
          if (error) throw error;
        } else {
          const { error } = await supabase
            .from('notification_preferences')
            .insert({ user_id: user!.id, ...payload });
          if (error) throw error;
        }

        toast({ title: t('notifications.saved') });
      } catch (error: any) {
        toast({
          title: t('notifications.saveError'),
          description: error.message,
          variant: 'destructive',
        });
      } finally {
        setSaving(false);
      }
    },
    [user, toast, t]
  );

  const updatePref = (key: keyof NotificationPrefs, value: Frequency) => {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    savePreferences(next);
  };

  const categories =
    effectiveRole === 'player'
      ? getPlayerCategories(t)
      : getTrainerCategories(t);

  const defaultFrequencies: Frequency[] = ['instant', 'daily', 'weekly', 'off'];

  if (loading || dataLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10">
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-3">
            <Bell className="h-6 w-6 text-primary" />
            <span className="font-bold text-xl">{t('notifications.title')}</span>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-2xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold mb-2">{t('notifications.heading')}</h1>
          <p className="text-muted-foreground">{t('notifications.subtitle')}</p>
        </div>

        <div className="space-y-6">
          {categories.map((category, ci) => (
            <Card key={ci}>
              <CardHeader>
                <CardTitle className="text-lg">{category.title}</CardTitle>
                <CardDescription>{category.description}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {category.items.map((item, ii) => {
                  const freqs = item.allowedFrequencies || defaultFrequencies;
                  return (
                    <div key={item.key}>
                      {ii > 0 && <Separator className="mb-4" />}
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-start gap-3 min-w-0">
                          <div className="mt-0.5 shrink-0">{item.icon}</div>
                          <div className="min-w-0">
                            <Label className="font-medium">
                              {t(`notifications.types.${item.key}.label`)}
                            </Label>
                            <p className="text-sm text-muted-foreground">
                              {t(`notifications.types.${item.key}.description`)}
                            </p>
                          </div>
                        </div>
                        <Select
                          value={prefs[item.key]}
                          onValueChange={(v) => updatePref(item.key, v as Frequency)}
                          disabled={saving}
                        >
                          <SelectTrigger className="w-[130px] shrink-0">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {freqs.map((f) => (
                              <SelectItem key={f} value={f}>
                                {t(`notifications.frequency.${f}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ))}
        </div>

        <p className="text-sm text-muted-foreground mt-6 text-center">
          {t('notifications.securityNote')}
        </p>
      </main>
    </div>
  );
}
