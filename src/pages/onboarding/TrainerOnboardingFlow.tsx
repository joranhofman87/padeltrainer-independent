import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { getTrainerProfile, setUserRole, ensureTrainerProfile } from '@/lib/auth';
import { computeTargetLiveDate } from '@/lib/onboardingResponses';
import type { OnboardingResponsesRow } from '@/lib/onboardingResponses';
import { useOnboardingResponses } from '@/hooks/useOnboardingResponses';
import { OnboardingProgressIndicator } from '@/components/trainer/onboarding/OnboardingProgressIndicator';
import { OnboardingStep1Profile } from '@/components/trainer/onboarding/OnboardingStep1Profile';
import {
  OnboardingStepSituation,
  type SituationFormValues,
} from '@/components/trainer/onboarding/OnboardingStepSituation';
import { OnboardingStepPainImpact } from '@/components/trainer/onboarding/OnboardingStepPainImpact';
import {
  OnboardingStepCriticalEvent,
  type CriticalEventFormValues,
} from '@/components/trainer/onboarding/OnboardingStepCriticalEvent';
import type { AdminHoursRange, PainTag } from '@/lib/onboardingResponses';
import { trackOnboardingEvent } from '@/lib/onboardingTracking';
import {
  ensureTrainerOnboardingRow,
  isPostgrestError,
  logSupabaseError,
} from '@/lib/trainerOnboardingLegacy';
import { Logo } from '@/components/Logo';
import { logger } from '@/lib/logger';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

const TOTAL_STEPS = 4;

function isProfileBasicsComplete(fullName: string | null | undefined, bio: string | null | undefined) {
  return !!(fullName?.trim() && bio?.trim());
}

function isSituationComplete(row: OnboardingResponsesRow | null) {
  return !!(
    row?.trainer_type &&
    row.lessons_per_week_range &&
    row.player_count_range &&
    row.primary_city?.trim()
  );
}

function isPainImpactComplete(row: OnboardingResponsesRow | null) {
  return !!(row?.primary_pains?.length && row.admin_hours_per_week);
}

function isCriticalEventComplete(row: OnboardingResponsesRow | null) {
  return !!row?.target_live_window;
}

function resolveResumeStep(
  profileComplete: boolean,
  responses: OnboardingResponsesRow | null,
): number {
  if (responses?.completed_at) {
    return TOTAL_STEPS + 1;
  }
  if (!profileComplete) {
    return 1;
  }
  if (!isSituationComplete(responses)) {
    return 2;
  }
  if (!isPainImpactComplete(responses)) {
    return 3;
  }
  if (!isCriticalEventComplete(responses)) {
    return 4;
  }
  return 4;
}

export default function TrainerOnboardingFlow() {
  const { user, loading, refreshAuth } = useAuth();
  const navigate = useNavigate();
  const { toast: toastUi } = useToast();
  const { t } = useTranslation('auth');
  const { t: tOnboarding } = useTranslation('onboarding');

  const [currentStep, setCurrentStep] = useState(1);
  const [initializing, setInitializing] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);
  const [trainerProfileId, setTrainerProfileId] = useState<string | null>(null);

  const {
    data: responses,
    isLoading: responsesLoading,
    error: responsesError,
    refetch: refetchResponses,
    saveResponses,
    isSaving,
  } = useOnboardingResponses(trainerProfileId ?? undefined);

  const finishRedirect = useCallback(() => {
    const redirectUrl = localStorage.getItem('redirectAfterOnboarding');
    if (redirectUrl) {
      localStorage.removeItem('redirectAfterOnboarding');
      navigate(redirectUrl);
    } else {
      navigate('/app/trainer');
    }
  }, [navigate]);

  const initOnboarding = useCallback(async () => {
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
        await setUserRole(user.id, 'trainer', detectedTimezone);
        await refreshAuth();
      } else {
        await ensureTrainerProfile(user.id, detectedTimezone);
      }

      const trainerProfile = await getTrainerProfile(user.id);
      if (!trainerProfile?.id) {
        throw new Error(tOnboarding('errors.trainerProfileNotFound'));
      }
      setTrainerProfileId(trainerProfile.id);

      const { data: legacyOnboarding, error: legacyError } = await supabase
        .from('trainer_onboarding')
        .select('completed_at, current_step')
        .eq('user_id', user.id)
        .maybeSingle();

      if (legacyError) {
        logSupabaseError('trainer_onboarding load failed during init', legacyError, {
          userId: user.id,
        });
        throw legacyError;
      }

      if (legacyOnboarding?.completed_at) {
        navigate('/app/trainer', { replace: true });
        return;
      }

      if (!legacyOnboarding) {
        const { created } = await ensureTrainerOnboardingRow(user.id);
        if (created) {
          trackOnboardingEvent('onboarding_started');
        }
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, bio')
        .eq('user_id', user.id)
        .maybeSingle();

      const profileComplete = isProfileBasicsComplete(profile?.full_name, profile?.bio);
      const spicedRow = await supabase
        .from('trainer_onboarding_responses')
        .select('*')
        .eq('trainer_profile_id', trainerProfile.id)
        .maybeSingle();

      if (spicedRow.error) {
        throw spicedRow.error;
      }

      if (spicedRow.data?.completed_at) {
        await supabase
          .from('trainer_onboarding')
          .update({
            completed_at: spicedRow.data.completed_at,
            current_step: TOTAL_STEPS,
          })
          .eq('user_id', user.id);
        navigate('/app/trainer', { replace: true });
        return;
      }

      const step = resolveResumeStep(profileComplete, spicedRow.data);
      if (step > TOTAL_STEPS) {
        navigate('/app/trainer', { replace: true });
        return;
      }
      setCurrentStep(step);
    } catch (e) {
      logSupabaseError('Error initializing SPICED trainer onboarding', e, {
        component: 'TrainerOnboardingFlow',
        userId: user.id,
      });
      const message =
        e instanceof Error && !isPostgrestError(e)
          ? e.message
          : tOnboarding('errors.initFailed');
      setInitError(message);
      toastUi({
        title: t('signUp.error', 'Error'),
        description: message,
        variant: 'destructive',
      });
    } finally {
      setInitializing(false);
    }
  }, [user, refreshAuth, navigate, t, tOnboarding, toastUi]);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate('/app/signup/trainer');
      return;
    }
    initOnboarding();
  }, [user, loading, navigate, initOnboarding]);

  const saveLegacyProgress = async (step: number, extra?: Record<string, unknown>) => {
    if (!user) {
      throw new Error('No authenticated user');
    }
    const { error } = await supabase
      .from('trainer_onboarding')
      .update({ current_step: step, ...extra })
      .eq('user_id', user.id);
    if (error) {
      throw error;
    }
  };

  const requireTrainerProfileId = (): trainerProfileId is string => {
    if (trainerProfileId) {
      return true;
    }
    const message = tOnboarding('errors.trainerProfileMissing');
    logger.error('trainerProfileId missing during onboarding save', new Error(message), {
      component: 'TrainerOnboardingFlow',
      step: currentStep,
      userId: user?.id,
    });
    toast.error(message);
    return false;
  };

  const handleSaveError = (error: unknown, messageKey = 'spiced.common.saveError') => {
    logger.error('Failed to save onboarding step', error as Error, {
      component: 'TrainerOnboardingFlow',
      step: currentStep,
    });
    toast.error(tOnboarding(messageKey));
  };

  const handleLegacyProgressError = (error: unknown) => {
    handleSaveError(error, 'spiced.common.legacyProgressError');
  };

  const handleStep1Next = async () => {
    try {
      await saveLegacyProgress(2);
      trackOnboardingEvent('profile_mvp_completed');
      setCurrentStep(2);
    } catch (e) {
      handleLegacyProgressError(e);
    }
  };

  const handleStep2Next = async (values: SituationFormValues) => {
    if (!requireTrainerProfileId()) return;
    try {
      await saveResponses({
        trainer_type: values.trainer_type,
        lessons_per_week_range: values.lessons_per_week_range,
        player_count_range: values.player_count_range,
        primary_city: values.primary_city.trim(),
      });
      await saveLegacyProgress(3);
      setCurrentStep(3);
    } catch (e) {
      handleSaveError(e);
    }
  };

  const handleStep3Next = async (values: {
    primary_pains: PainTag[];
    admin_hours_per_week: AdminHoursRange;
  }) => {
    if (!requireTrainerProfileId()) return;
    try {
      await saveResponses({
        primary_pains: values.primary_pains,
        admin_hours_per_week: values.admin_hours_per_week,
      });
      await saveLegacyProgress(4);
      setCurrentStep(4);
    } catch (e) {
      handleSaveError(e);
    }
  };

  const handleStep4Complete = async (values: CriticalEventFormValues) => {
    if (!user) return;
    if (!requireTrainerProfileId()) return;

    const completedAt = new Date().toISOString();
    const targetLiveDate = computeTargetLiveDate(values.target_live_window);
    const note = values.critical_event_note.trim();

    try {
      await saveResponses({
        target_live_window: values.target_live_window,
        target_live_date: targetLiveDate,
        critical_event_note: note || null,
        completed_at: completedAt,
      });

      const { error: legacyError } = await supabase
        .from('trainer_onboarding')
        .update({ completed_at: completedAt, current_step: TOTAL_STEPS })
        .eq('user_id', user.id);

      if (legacyError) {
        throw legacyError;
      }

      sessionStorage.removeItem('pendingRole');
      localStorage.removeItem('pendingRole');

      await refreshAuth();
      trackOnboardingEvent('onboarding_completed');
      finishRedirect();
    } catch (e) {
      logger.error('Failed to complete trainer onboarding', e as Error, {
        component: 'TrainerOnboardingFlow',
        step: 4,
        userId: user.id,
        trainerProfileId,
      });
      toast.error(tOnboarding('spiced.common.completionError'));
    }
  };

  const showShellLoading =
    loading || initializing || (!!trainerProfileId && responsesLoading && !responsesError);

  if (showShellLoading) {
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
            <Button onClick={() => initOnboarding()}>{tOnboarding('errors.retry')}</Button>
            <Button variant="outline" asChild>
              <Link to="/app/signup">{t('signupPicker.title', 'Choose account type')}</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (responsesError && trainerProfileId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="container max-w-lg mx-auto text-center space-y-4">
          <Logo className="h-8 mx-auto" />
          <p className="text-destructive text-sm">{tOnboarding('errors.loadFailed')}</p>
          <Button onClick={() => refetchResponses()}>{tOnboarding('errors.retry')}</Button>
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

        <div className="mb-8">
          <OnboardingProgressIndicator currentStep={currentStep} totalSteps={TOTAL_STEPS} />
        </div>

        {currentStep === 1 && <OnboardingStep1Profile onNext={handleStep1Next} />}

        {currentStep === 2 && (
          <OnboardingStepSituation
            initialData={responses}
            onBack={() => setCurrentStep(1)}
            onNext={handleStep2Next}
            isSaving={isSaving}
          />
        )}

        {currentStep === 3 && (
          <OnboardingStepPainImpact
            initialData={responses}
            onBack={() => setCurrentStep(2)}
            onNext={handleStep3Next}
            isSaving={isSaving}
          />
        )}

        {currentStep === 4 && (
          <OnboardingStepCriticalEvent
            initialData={responses}
            onBack={() => setCurrentStep(3)}
            onComplete={handleStep4Complete}
            isSaving={isSaving}
          />
        )}
      </div>
    </div>
  );
}
