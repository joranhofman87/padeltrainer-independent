import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { setUserRole } from '@/lib/auth';
import { OnboardingProgressBar } from '@/components/trainer/onboarding/OnboardingProgressBar';
import { OnboardingStep1Profile } from '@/components/trainer/onboarding/OnboardingStep1Profile';
import { OnboardingStep2Done } from '@/components/trainer/onboarding/OnboardingStep2Done';
import { trackOnboardingEvent } from '@/lib/onboardingTracking';
import { Logo } from '@/components/Logo';
import { logger } from '@/lib/logger';

const TOTAL_STEPS = 2;

export default function TrainerOnboarding() {
  const { user, loading, refreshAuth } = useAuth();
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState(1);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate('/app/signup/trainer');
      return;
    }
    initOnboarding();
  }, [user, loading]);

  const initOnboarding = async () => {
    if (!user) return;

    try {
      // Ensure trainer role exists
      const hasTrainerRole = await supabase
        .from('user_roles')
        .select('id')
        .eq('user_id', user.id)
        .eq('role', 'trainer')
        .maybeSingle();

      if (!hasTrainerRole.data) {
        await setUserRole(user.id, 'trainer');
        await refreshAuth();
      }

      // Check for existing onboarding progress
      const { data: existing } = await supabase
        .from('trainer_onboarding')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();

      if (existing) {
        if (existing.completed_at) {
          navigate('/app/trainer/get-started');
          return;
        }
        // Map old steps: anything >= 2 in old flow means profile is done
        const resumeStep = existing.current_step >= 2 ? 2 : 1;
        setCurrentStep(resumeStep);
      } else {
        await supabase.from('trainer_onboarding').insert({
          user_id: user.id,
          current_step: 1,
        });
        trackOnboardingEvent('onboarding_started');
      }
    } catch (e) {
      logger.error('Error initializing onboarding', e instanceof Error ? e : new Error(String(e)), { component: 'TrainerOnboarding' });
    } finally {
      setInitializing(false);
    }
  };

  const saveProgress = async (step: number, extraData?: Record<string, any>) => {
    if (!user) return;
    await supabase
      .from('trainer_onboarding')
      .update({ current_step: step, ...extraData })
      .eq('user_id', user.id);
  };

  const handleStep1Next = async () => {
    await saveProgress(2);
    trackOnboardingEvent('profile_mvp_completed');
    setCurrentStep(2);
  };

  const handleComplete = async () => {
    if (!user) return;
    await supabase
      .from('trainer_onboarding')
      .update({ completed_at: new Date().toISOString(), current_step: 2 })
      .eq('user_id', user.id);

    sessionStorage.removeItem('pendingRole');
    localStorage.removeItem('pendingRole');

    await refreshAuth();
    trackOnboardingEvent('onboarding_completed');

    const redirectUrl = localStorage.getItem('redirectAfterOnboarding');
    if (redirectUrl) {
      localStorage.removeItem('redirectAfterOnboarding');
      navigate(redirectUrl);
    } else {
      navigate('/app/trainer/get-started');
    }
  };

  if (loading || initializing) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-secondary/5">
      <div className="container max-w-lg mx-auto px-4 py-8">
        <div className="flex justify-center mb-6">
          <Logo className="h-8" />
        </div>

        {currentStep === 1 && (
          <>
            <div className="mb-8">
              <OnboardingProgressBar currentStep={currentStep} totalSteps={TOTAL_STEPS} />
            </div>
            <OnboardingStep1Profile onNext={handleStep1Next} />
          </>
        )}
        {currentStep === 2 && (
          <OnboardingStep2Done onComplete={handleComplete} />
        )}
      </div>
    </div>
  );
}
