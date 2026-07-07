import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { MoneyInput } from '@/components/ui/money-input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';
import { computeTrainerProfileSetupComplete } from '@/lib/trainerSetupPlan';
import { getFirstName } from '@/lib/profileName';

interface OnboardingStep1ProfileProps {
  onNext: () => void;
}

export function OnboardingStep1Profile({ onNext }: OnboardingStep1ProfileProps) {
  const { user } = useAuth();
  const { t } = useTranslation('trainer');
  const { t: tOnboarding } = useTranslation('onboarding');
  const [greetingName, setGreetingName] = useState('');
  const [bio, setBio] = useState('');
  const [hourlyRate, setHourlyRate] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (user) loadExistingData();
  }, [user]);

  const loadExistingData = async () => {
    try {
      const [{ data: profile }, { data: trainerProfile }] = await Promise.all([
        supabase
          .from('profiles')
          .select('first_name, last_name, full_name, bio')
          .eq('user_id', user!.id)
          .maybeSingle(),
        supabase.from('trainer_profiles').select('hourly_rate').eq('user_id', user!.id).maybeSingle(),
      ]);

      if (profile) {
        setGreetingName(getFirstName(profile));
        setBio(profile.bio || '');
      }

      if (trainerProfile?.hourly_rate != null && trainerProfile.hourly_rate > 0) {
        setHourlyRate(String(trainerProfile.hourly_rate));
      }
    } catch (e) {
      logger.error('Failed to load profile data', e as Error, { component: 'OnboardingStep1Profile' });
    } finally {
      setLoading(false);
    }
  };

  const parsedHourlyRate = hourlyRate.trim() ? parseFloat(hourlyRate) : NaN;

  const canProceed = computeTrainerProfileSetupComplete({
    bio,
    hourlyRate: Number.isFinite(parsedHourlyRate) ? parsedHourlyRate : null,
  });

  const handleSave = async () => {
    if (!user || !canProceed) return;

    setSaving(true);
    try {
      const rate = parseFloat(hourlyRate);

      const { error: profileError } = await supabase
        .from('profiles')
        .update({
          bio: bio.trim(),
        })
        .eq('user_id', user.id);

      if (profileError) throw profileError;

      const { error: trainerError } = await supabase
        .from('trainer_profiles')
        .update({ hourly_rate: rate })
        .eq('user_id', user.id);

      if (trainerError) throw trainerError;

      onNext();
    } catch (error: unknown) {
      logger.error('Error saving profile', error as Error, { component: 'OnboardingStep1Profile' });
      toast.error(tOnboarding('errors.profileSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  const greeting = greetingName
    ? t('onboarding.step1.greeting', { name: greetingName })
    : t('onboarding.step1.greetingNoName');

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-bold">{t('onboarding.step1.title')}</h1>
        <p className="text-muted-foreground">{greeting}</p>
        <p className="text-sm text-muted-foreground">{t('onboarding.step1.subtitle')}</p>
      </div>

      <div className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="bio">{t('onboarding.step1.bioLabel')} *</Label>
          <Textarea
            id="bio"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder={t('onboarding.step1.bioPlaceholder')}
            rows={2}
          />
          <p className="text-xs text-muted-foreground">{t('onboarding.step1.bioHint')}</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="hourlyRate">{t('onboarding.step1.hourlyRateLabel')} *</Label>
          <MoneyInput
            id="hourlyRate"
            type="number"
            min={1}
            step={1}
            inputMode="decimal"
            value={hourlyRate}
            onChange={(e) => setHourlyRate(e.target.value)}
            placeholder={t('onboarding.step1.hourlyRatePlaceholder')}
          />
        </div>
      </div>

      <Button size="lg" className="w-full" disabled={!canProceed || saving} onClick={handleSave}>
        {saving ? t('onboarding.step1.saving') : t('onboarding.step1.continue')}
      </Button>
    </div>
  );
}
