import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';

interface OnboardingStep1ProfileProps {
  onNext: () => void;
}

export function OnboardingStep1Profile({ onNext }: OnboardingStep1ProfileProps) {
  const { user } = useAuth();
  const { t } = useTranslation('trainer');
  const { t: tOnboarding } = useTranslation('onboarding');
  const [fullName, setFullName] = useState('');
  const [bio, setBio] = useState('');
  const [hourlyRate, setHourlyRate] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (user) loadExistingData();
  }, [user]);

  const loadExistingData = async () => {
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, bio')
        .eq('user_id', user!.id)
        .maybeSingle();

      if (profile) {
        setFullName(profile.full_name || '');
        setBio(profile.bio || '');
      }

    } catch (e) {
      logger.error('Failed to load profile data', e as Error, { component: 'OnboardingStep1Profile' });
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!user || !fullName.trim() || !bio.trim()) return;

    setSaving(true);
    try {
      // Update profiles table
      const { error: profileError } = await supabase
        .from('profiles')
        .update({
          full_name: fullName.trim(),
          bio: bio.trim(),
        })
        .eq('user_id', user.id);

      if (profileError) throw profileError;

      onNext();
    } catch (error: any) {
      logger.error('Error saving profile', error as Error, { component: 'OnboardingStep1Profile' });
      toast.error(tOnboarding('errors.profileSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const canProceed = fullName.trim().length > 0 && bio.trim().length > 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-bold">{t('onboarding.step1.title')}</h1>
        <p className="text-muted-foreground">{t('onboarding.step1.subtitle')}</p>
      </div>

      <div className="space-y-5">
        {/* Name */}
        <div className="space-y-2">
          <Label htmlFor="fullName">{t('onboarding.step1.nameLabel')} *</Label>
          <Input
            id="fullName"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder={t('players.fullNamePlaceholder')}
          />
        </div>

        {/* One-liner bio */}
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

      </div>

      <Button
        size="lg"
        className="w-full"
        disabled={!canProceed || saving}
        onClick={handleSave}
      >
        {saving ? t('onboarding.step1.saving') : t('onboarding.step1.continue')}
      </Button>
    </div>
  );
}
