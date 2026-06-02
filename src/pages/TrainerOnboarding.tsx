import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { setUserRole, ensureTrainerProfile } from '@/lib/auth';
import { OnboardingProgressBar } from '@/components/trainer/onboarding/OnboardingProgressBar';
import { OnboardingStep1Profile } from '@/components/trainer/onboarding/OnboardingStep1Profile';
import { OnboardingStep2Done } from '@/components/trainer/onboarding/OnboardingStep2Done';
import { trackOnboardingEvent } from '@/lib/onboardingTracking';
import { Logo } from '@/components/Logo';
import { logger } from '@/lib/logger';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { useTranslation } from 'react-i18next';

const TOTAL_STEPS = 2;

export default function TrainerOnboarding() {
  const { user, loading, refreshAuth } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t } = useTranslation('auth');
  const [currentStep, setCurrentStep] = useState(1);
  const [initializing, setInitializing] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);

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

    setInitError(null);

    try {
      const { data: roleRow, error: roleCheckError } = await supabase
        .from('user_roles')
        .select('id')
        .eq('user_id', user.id)
        .eq('role', 'trainer')
        .maybeSingle();

      if (roleCheckError) {
        throw roleCheckError;
      }

      const detectedTimezone =
        Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Amsterdam';

      if (!roleRow) {
        try {
          await setUserRole(user.id, 'trainer', detectedTimezone);
          await refreshAuth();
        } catch (roleErr: unknown) {
          const err =
            roleErr instanceof Error ? roleErr : new Error(String(roleErr));
          logger.error('Failed to assign trainer role during onboarding', err, {
            component: 'TrainerOnboarding',
            userId: user.id,
            code: (roleErr as { code?: string })?.code,
          });
          const message =
            err.message ||
            t(
              'onboarding.trainerRoleFailed',
              'Could not assign your trainer account. Please try again or contact support.',
            );
          setInitError(message);
          toast({
            title: t('signUp.error', 'Error'),
            description: message,
            variant: 'destructive',
          });
          return;
        }
      } else {
        try {
          await ensureTrainerProfile(user.id, detectedTimezone);
        } catch (profileErr: unknown) {
          const err =
            profileErr instanceof Error ? profileErr : new Error(String(profileErr));
          logger.error('Failed to ensure trainer profile during onboarding', err, {
            component: 'TrainerOnboarding',
            userId: user.id,
          });
          const message =
            err.message ||
            t(
              'onboarding.trainerInitFailed',
              'Could not start trainer onboarding. Please try again.',
            );
          setInitError(message);
          toast({
            title: t('signUp.error', 'Error'),
            description: message,
            variant: 'destructive',
          });
          return;
        }
      }

      const { data: existing, error: onboardingError } = await supabase
        .from('trainer_onboarding')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();

      if (onboardingError) {
        throw onboardingError;
      }

      if (existing) {
        if (existing.completed_at) {
          navigate('/app/trainer/get-started');
          return;
        }
        const resumeStep = existing.current_step >= 2 ? 2 : 1;
        setCurrentStep(resumeStep);
      } else {
        const { error: insertError } = await supabase.from('trainer_onboarding').insert({
          user_id: user.id,
          current_step: 1,
        });
        if (insertError) {
          throw insertError;
        }
        trackOnboardingEvent('onboarding_started');
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      logger.error('Error initializing trainer onboarding', err, {
        component: 'TrainerOnboarding',
        userId: user.id,
      });
      const message =
        err.message ||
        t(
          'onboarding.trainerInitFailed',
          'Could not start trainer onboarding. Please try again.',
        );
      setInitError(message);
      toast({
        title: t('signUp.error', 'Error'),
        description: message,
        variant: 'destructive',
      });
    } finally {
      setInitializing(false);
    }
  };

  const saveProgress = async (step: number, extraData?: Record<string, unknown>) => {
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

  if (initError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="container max-w-lg mx-auto text-center space-y-4">
          <Logo className="h-8 mx-auto" />
          <p className="text-destructive text-sm">{initError}</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
            <Button onClick={() => initOnboarding()}>{t('signIn.button', 'Try again')}</Button>
            <Button variant="outline" asChild>
              <Link to="/app/signup">{t('signupPicker.title', 'Choose account type')}</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
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
