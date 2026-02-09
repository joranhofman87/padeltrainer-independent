import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { getAcademyPaymentInfo, type AcademyPaymentInfo } from '@/lib/academyTrainerPayments';
import { TrainerSetupChecklist } from '@/components/trainer/TrainerSetupChecklist';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { CheckCircle2 } from 'lucide-react';
import { logger } from '@/lib/logger';

interface SetupStatus {
  profileComplete: boolean;
  hasAvailability: boolean;
  paymentsComplete: boolean;
  hasPlayers: boolean;
  academyPaymentInfo?: AcademyPaymentInfo;
}

export default function TrainerGetStarted() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation('trainer');
  const [setupStatus, setSetupStatus] = useState<SetupStatus>({
    profileComplete: false,
    hasAvailability: false,
    paymentsComplete: false,
    hasPlayers: false,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (user) fetchSetupStatus();
  }, [user]);

  const fetchSetupStatus = async () => {
    try {
      const { data: trainerProfile } = await supabase
        .from('trainer_profiles')
        .select('id, hourly_rate, use_manual_invoicing')
        .eq('user_id', user!.id)
        .maybeSingle();

      if (!trainerProfile) {
        setLoading(false);
        return;
      }

      const { data: profileData } = await supabase
        .from('profiles')
        .select('bio')
        .eq('user_id', user!.id)
        .maybeSingle();

      const profileComplete = !!(trainerProfile.hourly_rate && profileData?.bio);
      const currentTrainerId = trainerProfile.id;

      const { count: slotCount } = await supabase
        .from('availability_slots')
        .select('id', { count: 'exact', head: true })
        .eq('trainer_id', currentTrainerId);

      const { data: mollieData } = await supabase
        .from('trainer_mollie_accounts')
        .select('onboarding_complete, charges_enabled')
        .eq('trainer_id', currentTrainerId)
        .maybeSingle();

      const academyPaymentInfo = await getAcademyPaymentInfo(currentTrainerId);

      const paymentsComplete =
        !!(mollieData?.onboarding_complete && mollieData?.charges_enabled) ||
        !!trainerProfile.use_manual_invoicing ||
        (academyPaymentInfo.isAcademyTrainer && academyPaymentInfo.academyChargesEnabled);

      const { count: playerCount } = await supabase
        .from('guest_players')
        .select('id', { count: 'exact', head: true })
        .eq('trainer_id', currentTrainerId);

      setSetupStatus({
        profileComplete,
        hasAvailability: (slotCount || 0) > 0,
        paymentsComplete,
        hasPlayers: (playerCount || 0) > 0,
        academyPaymentInfo,
      });
    } catch (error) {
      logger.error('Error fetching setup status', error as Error, { component: 'TrainerGetStarted' });
    } finally {
      setLoading(false);
    }
  };

  const handleDismiss = async () => {
    if (!user) return;
    await supabase
      .from('trainer_onboarding')
      .update({ setup_dismissed_at: new Date().toISOString() } as any)
      .eq('user_id', user.id);
    navigate('/app/trainer');
  };

  const allComplete =
    setupStatus.profileComplete &&
    setupStatus.hasAvailability &&
    setupStatus.paymentsComplete &&
    setupStatus.hasPlayers;

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto py-8 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (allComplete) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center space-y-6">
        <CheckCircle2 className="h-16 w-16 text-green-500 mx-auto" />
        <h1 className="text-2xl font-bold">{t('getStarted.allDone', 'You\'re all set!')}</h1>
        <p className="text-muted-foreground">
          {t('getStarted.allDoneDescription', 'Your trainer profile is fully configured. You\'re ready to receive bookings!')}
        </p>
        <Button onClick={() => navigate('/app/trainer')} size="lg">
          {t('getStarted.goToDashboard', 'Go to Dashboard')}
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto py-8">
      <TrainerSetupChecklist
        setupStatus={setupStatus}
        onNavigate={(path) => navigate(`/app${path}`)}
        onDismiss={handleDismiss}
      />
    </div>
  );
}
