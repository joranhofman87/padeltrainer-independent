import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { setUserRole } from '@/lib/auth';
import { OnboardingProgressBar } from '@/components/trainer/onboarding/OnboardingProgressBar';
import { OnboardingStep1Goal, Step1Data } from '@/components/trainer/onboarding/OnboardingStep1Goal';
import { OnboardingStep2Profile } from '@/components/trainer/onboarding/OnboardingStep2Profile';
import { OnboardingStep3Schedule } from '@/components/trainer/onboarding/OnboardingStep3Schedule';
import { OnboardingStep4Done } from '@/components/trainer/onboarding/OnboardingStep4Done';
import { trackOnboardingEvent } from '@/lib/onboardingTracking';
import { Logo } from '@/components/Logo';

const TOTAL_STEPS = 4;

export default function TrainerOnboarding() {
  const { user, role, loading, refreshAuth } = useAuth();
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState(1);
  const [step1Data, setStep1Data] = useState<Step1Data>({
    goal: '',
    goalOtherText: '',
    followupAnswer: '',
  });
  const [initializing, setInitializing] = useState(true);

  // On mount: ensure trainer role + check resume
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
          // Already completed - redirect to dashboard
          navigate('/app/trainer/get-started');
          return;
        }
        // Resume
        setCurrentStep(existing.current_step || 1);
        setStep1Data({
          goal: existing.goal || '',
          goalOtherText: existing.goal_other_text || '',
          followupAnswer: existing.followup_answer || '',
        });
      } else {
        // Create new onboarding row
        await supabase.from('trainer_onboarding').insert({
          user_id: user.id,
          current_step: 1,
        });
        trackOnboardingEvent('onboarding_started');
      }
    } catch (e) {
      console.error('Error initializing onboarding:', e);
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

  const handleStep1Next = async (data: Step1Data) => {
    setStep1Data(data);
    await saveProgress(2, {
      goal: data.goal,
      goal_other_text: data.goalOtherText || null,
      followup_answer: data.followupAnswer || null,
    });
    trackOnboardingEvent('step1_goal_selected', { goal: data.goal });
    setCurrentStep(2);
  };

  const handleStep2Next = async () => {
    await saveProgress(3);
    trackOnboardingEvent('profile_mvp_completed');
    setCurrentStep(3);
  };

  const handleStep3Next = async () => {
    await saveProgress(4);
    trackOnboardingEvent('lesson_created');
    setCurrentStep(4);
  };

  const handleComplete = async () => {
    if (!user) return;
    await supabase
      .from('trainer_onboarding')
      .update({ completed_at: new Date().toISOString(), current_step: 4 })
      .eq('user_id', user.id);

    // Clear pending role storage
    sessionStorage.removeItem('pendingRole');
    localStorage.removeItem('pendingRole');

    await refreshAuth();
    trackOnboardingEvent('onboarding_completed');
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
        {/* Logo */}
        <div className="flex justify-center mb-6">
          <Logo className="h-8" />
        </div>

        {/* Progress */}
        {currentStep < 4 && (
          <div className="mb-8">
            <OnboardingProgressBar currentStep={currentStep} totalSteps={TOTAL_STEPS} />
          </div>
        )}

        {/* Steps */}
        {currentStep === 1 && (
          <OnboardingStep1Goal initialData={step1Data} onNext={handleStep1Next} />
        )}
        {currentStep === 2 && (
          <OnboardingStep2Profile
            onNext={handleStep2Next}
            onBack={() => setCurrentStep(1)}
          />
        )}
        {currentStep === 3 && (
          <OnboardingStep3Schedule
            onNext={handleStep3Next}
            onBack={() => setCurrentStep(2)}
          />
        )}
        {currentStep === 4 && (
          <OnboardingStep4Done onComplete={handleComplete} />
        )}
      </div>
    </div>
  );
}
