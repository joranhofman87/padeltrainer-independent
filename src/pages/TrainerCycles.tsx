import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Plus, CalendarDays, PartyPopper, Copy } from 'lucide-react';
import { getCycles, type Cycle } from '@/lib/cycles';
import CycleCard from '@/components/cycles/CycleCard';
import { logger } from '@/lib/logger';
import { TrainerPageHeader } from '@/components/trainer/shell/TrainerPageHeader';
import { DashboardEmptyState } from '@/components/trainer/dashboard/DashboardEmptyState';

export default function TrainerCycles() {
  const { t } = useTranslation('cycles');
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [trainerId, setTrainerId] = useState<string | null>(null);

  useEffect(() => {
    const fetchTrainerId = async () => {
      if (!user) return;
      const { data } = await supabase
        .from('trainer_profiles')
        .select('id')
        .eq('user_id', user.id)
        .single();
      if (data) setTrainerId(data.id);
    };
    if (user) fetchTrainerId();
  }, [user]);

  const fetchCycles = async () => {
    if (!trainerId) return;
    setIsLoading(true);
    try {
      const data = await getCycles('trainer', trainerId);
      setCycles(data);
    } catch (error: any) {
      logger.error('Error fetching cycles', error instanceof Error ? error : new Error(String(error)), { component: 'TrainerCycles' });
      toast({ title: t('common:error'), description: error.message, variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (trainerId) fetchCycles();
  }, [trainerId]);

  const goCreateRegistration = () => navigate('/app/trainer/cycles/new?type=registration');

  if (loading || isLoading) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-5 py-2">
        <Skeleton className="h-10 w-48" />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5 py-2">
      <TrainerPageHeader
        title={t('registration.openCycles', 'Registrations')}
        description={t('noRegistrationsDescription', 'Create registrations to collect player interest')}
        primaryAction={{
          label: t('createRegistration', 'Create Registration'),
          onClick: goCreateRegistration,
          icon: Plus,
        }}
        moreMenuItems={[
          {
            label: t('createEvent', 'Create Event'),
            onClick: () => navigate('/app/trainer/cycles/new?type=event'),
            icon: PartyPopper,
          },
          {
            label: t('bulkCopy.cta', 'Volgende ronde opzetten'),
            onClick: () => navigate('/app/trainer/cycles/bulk-copy'),
            icon: Copy,
          },
        ]}
      />

      {cycles.length === 0 ? (
        <div className="rounded-lg border border-border/80 bg-card shadow-sm">
          <DashboardEmptyState
            icon={CalendarDays}
            message={t('noRegistrations', 'No registrations yet')}
            hint={t('noRegistrationsDescription', 'Create a registration to start collecting player interest')}
          />
          <div className="flex justify-center border-t border-border/60 px-4 pb-8 pt-2">
            <Button
              className="bg-[hsl(var(--brand-500))] hover:bg-[hsl(var(--brand-600))]"
              onClick={goCreateRegistration}
            >
              <Plus className="mr-2 h-4 w-4" />
              {t('createRegistration', 'Create Registration')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {cycles.map((cycle) => (
            <CycleCard
              key={cycle.id}
              cycle={cycle}
              onEdit={(c) => navigate(`/app/trainer/cycles/${c.id}/edit`)}
              onDeleted={fetchCycles}
            />
          ))}
        </div>
      )}
    </div>
  );
}
