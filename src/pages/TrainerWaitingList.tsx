import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabaseClient';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { ArrowLeft, ClipboardList, Loader2 } from 'lucide-react';
import { WaitingListTable } from '@/components/waitingList';
import { getTrainerProfile } from '@/lib/auth';

export default function TrainerWaitingList() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation('trainer');
  const { toast } = useToast();

  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [trainerProfileId, setTrainerProfileId] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && user) {
      fetchSettings();
    }
  }, [user, loading]);

  const fetchSettings = async () => {
    const profile = await getTrainerProfile(user!.id);
    if (profile) {
      setTrainerProfileId(profile.id);
      const { data } = await supabase
        .from('trainer_profiles')
        .select('waiting_list_enabled')
        .eq('id', profile.id)
        .single();
      if (data) {
        setEnabled((data as any).waiting_list_enabled || false);
      }
    }
    setLoadingSettings(false);
  };

  const handleToggle = async (value: boolean) => {
    if (!trainerProfileId) return;
    setSaving(true);
    const { error } = await supabase
      .from('trainer_profiles')
      .update({ waiting_list_enabled: value } as any)
      .eq('id', trainerProfileId);

    if (error) {
      toast({ title: t('common:error'), description: 'Failed to update setting', variant: 'destructive' });
    } else {
      setEnabled(value);
      toast({
        title: t('common:success'),
        description: value
          ? t('waitingList.enabled', 'Waiting list is now active on your profile')
          : t('waitingList.disabled', 'Waiting list has been turned off'),
      });
    }
    setSaving(false);
  };

  if (loading || loadingSettings) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <>
      <div className="border-b bg-background/60">
        <div className="container mx-auto px-4 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/app/trainer/cycles')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-xl font-bold">{t('waitingList.settingsTitle', 'Waiting List')}</h1>
            <p className="text-sm text-muted-foreground">{t('waitingList.settingsSubtitle', 'Let players join a waiting list when no spots are available')}</p>
          </div>
        </div>
      </div>

      <main className="container mx-auto px-4 py-8 max-w-2xl space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ClipboardList className="h-5 w-5 text-primary" />
              {t('waitingList.enableTitle', 'Enable Waiting List')}
            </CardTitle>
            <CardDescription>
              {t('waitingList.enableDescription', 'When enabled, players can sign up for your waiting list on your public profile. You\'ll be notified when someone joins.')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div className="flex-1 pr-4">
                <Label htmlFor="waiting-list-toggle" className="font-medium">
                  {t('waitingList.enableTitle', 'Enable Waiting List')}
                </Label>
                <p className="text-sm text-muted-foreground mt-1">
                  {t('waitingList.enableDescription', 'When enabled, players can sign up for your waiting list on your public profile.')}
                </p>
              </div>
              <Switch
                id="waiting-list-toggle"
                checked={enabled}
                onCheckedChange={handleToggle}
                disabled={saving}
              />
            </div>
            {saving && (
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground mt-4">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('common:saving', 'Saving...')}
              </div>
            )}
          </CardContent>
        </Card>

        {enabled && trainerProfileId && (
          <WaitingListTable ownerType="trainer" ownerId={trainerProfileId} />
        )}
      </main>
    </>
  );
}
