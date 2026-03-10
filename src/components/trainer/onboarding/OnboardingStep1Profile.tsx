import { useState, useEffect } from 'react';
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

      const { data: trainerProfile } = await supabase
        .from('trainer_profiles')
        .select('hourly_rate')
        .eq('user_id', user!.id)
        .maybeSingle();

      if (trainerProfile?.hourly_rate) {
        setHourlyRate(String(trainerProfile.hourly_rate));
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

      // Update hourly rate on trainer_profiles
      const rate = hourlyRate ? parseFloat(hourlyRate) : null;
      const { error: trainerError } = await supabase
        .from('trainer_profiles')
        .update({ hourly_rate: rate })
        .eq('user_id', user.id);

      if (trainerError) throw trainerError;

      onNext();
    } catch (error: any) {
      logger.error('Error saving profile', error as Error, { component: 'OnboardingStep1Profile' });
      toast.error('Failed to save profile. Please try again.');
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
        <h1 className="text-2xl font-bold">Let's get you live 🚀</h1>
        <p className="text-muted-foreground">Just 3 quick fields — you can refine everything later</p>
      </div>

      <div className="space-y-5">
        {/* Name */}
        <div className="space-y-2">
          <Label htmlFor="fullName">Your name *</Label>
          <Input
            id="fullName"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Your full name"
          />
        </div>

        {/* One-liner bio */}
        <div className="space-y-2">
          <Label htmlFor="bio">One-liner about you *</Label>
          <Textarea
            id="bio"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="e.g. Padel trainer in Amsterdam with 5 years of experience"
            rows={2}
          />
          <p className="text-xs text-muted-foreground">1–2 sentences is plenty. You can update this anytime.</p>
        </div>

        {/* Hourly rate */}
        <div className="space-y-2">
          <Label htmlFor="hourlyRate">Hourly rate (€) <span className="text-muted-foreground text-xs">(optional)</span></Label>
          <Input
            id="hourlyRate"
            type="number"
            step="0.01"
            min="0"
            value={hourlyRate}
            onChange={(e) => setHourlyRate(e.target.value)}
            placeholder="50.00"
          />
          <p className="text-xs text-muted-foreground">Shown on your profile. You can set per-session prices later.</p>
        </div>
      </div>

      <Button
        size="lg"
        className="w-full"
        disabled={!canProceed || saving}
        onClick={handleSave}
      >
        {saving ? 'Saving...' : 'Continue'}
      </Button>
    </div>
  );
}
