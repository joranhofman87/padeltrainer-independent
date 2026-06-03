import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Plus, CalendarDays, PartyPopper, Copy } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { getCycles, type Cycle } from '@/lib/cycles';
import CycleCard from '@/components/cycles/CycleCard';
import { logger } from '@/lib/logger';

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

  if (loading || isLoading) {
    return (
      <div className="mx-auto w-full max-w-7xl py-2">
        <Skeleton className="h-8 w-48 mb-6" />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 py-2">
      <PageHeader
        title={t('registration.openCycles', 'Registrations')}
        description={t('noRegistrationsDescription', 'Create registrations to collect player interest')}
        actions={
          <>
            <Button size="sm" onClick={() => navigate('/app/trainer/cycles/new?type=registration')}>
              <Plus className="mr-2 h-4 w-4" />
              {t('createRegistration', 'Create Registration')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => navigate('/app/trainer/cycles/new?type=event')}>
              <PartyPopper className="mr-2 h-4 w-4" />
              <span className="hidden sm:inline">{t('createEvent', 'Create Event')}</span>
            </Button>
            <Button size="sm" variant="outline" onClick={() => navigate('/app/trainer/cycles/bulk-copy')}>
              <Copy className="mr-2 h-4 w-4" />
              <span className="hidden md:inline">{t('bulkCopy.cta', 'Copy slots to next cycle')}</span>
            </Button>
          </>
        }
      />

      {cycles.length === 0 ? (
        <div className="text-center py-16">
          <div className="mx-auto h-16 w-16 rounded-full bg-muted flex items-center justify-center mb-4">
            <CalendarDays className="h-8 w-8 text-muted-foreground" />
          </div>
          <h3 className="font-semibold mb-1 text-lg">{t('noRegistrations', 'No registrations yet')}</h3>
          <p className="text-muted-foreground mb-6 max-w-md mx-auto">
            {t('noRegistrationsDescription', 'Create a registration to start collecting player interest')}
          </p>
          <Button onClick={() => navigate('/app/trainer/cycles/new?type=registration')}>
            <Plus className="mr-2 h-4 w-4" />
            {t('createRegistration', 'Create Registration')}
          </Button>
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
