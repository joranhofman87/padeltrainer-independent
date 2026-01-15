import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { ArrowLeft, Bell, Mail, Calendar, Star, Users } from 'lucide-react';

interface NotificationPrefs {
  email_booking_confirmation: boolean;
  email_booking_reminder: boolean;
  email_new_availability: boolean;
  email_review_received: boolean;
}

export default function NotificationSettings() {
  const { user, role, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [prefs, setPrefs] = useState<NotificationPrefs>({
    email_booking_confirmation: true,
    email_booking_reminder: true,
    email_new_availability: true,
    email_review_received: true,
  });
  const [dataLoading, setDataLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      navigate('/auth');
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
        setPrefs({
          email_booking_confirmation: data.email_booking_confirmation,
          email_booking_reminder: data.email_booking_reminder,
          email_new_availability: data.email_new_availability,
          email_review_received: data.email_review_received,
        });
      }
    } catch (error: any) {
      console.error('Error fetching preferences:', error);
    } finally {
      setDataLoading(false);
    }
  };

  const savePreferences = async () => {
    setSaving(true);
    try {
      const { data: existing } = await supabase
        .from('notification_preferences')
        .select('id')
        .eq('user_id', user!.id)
        .maybeSingle();

      if (existing) {
        const { error } = await supabase
          .from('notification_preferences')
          .update({
            ...prefs,
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', user!.id);

        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('notification_preferences')
          .insert({
            user_id: user!.id,
            ...prefs,
          });

        if (error) throw error;
      }

      toast({ title: 'Preferences saved!' });
    } catch (error: any) {
      toast({
        title: 'Error saving preferences',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const updatePref = (key: keyof NotificationPrefs, value: boolean) => {
    setPrefs((prev) => ({ ...prev, [key]: value }));
  };

  if (loading || dataLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-3">
            <Bell className="h-6 w-6 text-primary" />
            <span className="font-bold text-xl">Notification Settings</span>
          </div>
          <div className="ml-auto">
            <Button onClick={savePreferences} disabled={saving}>
              {saving ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-2xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold mb-2">Email Notifications</h1>
          <p className="text-muted-foreground">
            Control which email notifications you receive from PadelTrainer.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5" />
              Email Preferences
            </CardTitle>
            <CardDescription>
              Toggle notifications on or off based on your preferences
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Booking Confirmation */}
            <div className="flex items-center justify-between">
              <div className="flex items-start gap-3">
                <Calendar className="h-5 w-5 text-muted-foreground mt-0.5" />
                <div>
                  <Label htmlFor="booking-confirm" className="font-medium">
                    Booking Confirmations
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Get notified when a lesson is booked
                  </p>
                </div>
              </div>
              <Switch
                id="booking-confirm"
                checked={prefs.email_booking_confirmation}
                onCheckedChange={(v) => updatePref('email_booking_confirmation', v)}
              />
            </div>

            <Separator />

            {/* Booking Reminder */}
            <div className="flex items-center justify-between">
              <div className="flex items-start gap-3">
                <Bell className="h-5 w-5 text-muted-foreground mt-0.5" />
                <div>
                  <Label htmlFor="booking-reminder" className="font-medium">
                    Lesson Reminders
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Receive a reminder 24 hours before your lesson
                  </p>
                </div>
              </div>
              <Switch
                id="booking-reminder"
                checked={prefs.email_booking_reminder}
                onCheckedChange={(v) => updatePref('email_booking_reminder', v)}
              />
            </div>

            <Separator />

            {/* New Availability - Only for players */}
            {role === 'player' && (
              <>
                <div className="flex items-center justify-between">
                  <div className="flex items-start gap-3">
                    <Users className="h-5 w-5 text-muted-foreground mt-0.5" />
                    <div>
                      <Label htmlFor="new-availability" className="font-medium">
                        New Availability from Followed Trainers
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        Get notified when trainers you follow add new time slots
                      </p>
                    </div>
                  </div>
                  <Switch
                    id="new-availability"
                    checked={prefs.email_new_availability}
                    onCheckedChange={(v) => updatePref('email_new_availability', v)}
                  />
                </div>
                <Separator />
              </>
            )}

            {/* Review Received - Only for trainers */}
            {role === 'trainer' && (
              <div className="flex items-center justify-between">
                <div className="flex items-start gap-3">
                  <Star className="h-5 w-5 text-muted-foreground mt-0.5" />
                  <div>
                    <Label htmlFor="review-received" className="font-medium">
                      New Reviews
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      Get notified when a player leaves a review
                    </p>
                  </div>
                </div>
                <Switch
                  id="review-received"
                  checked={prefs.email_review_received}
                  onCheckedChange={(v) => updatePref('email_review_received', v)}
                />
              </div>
            )}
          </CardContent>
        </Card>

        <p className="text-sm text-muted-foreground mt-6 text-center">
          Note: Essential account and security notifications cannot be disabled.
        </p>
      </main>
    </div>
  );
}
