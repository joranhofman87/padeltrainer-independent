import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft, Plus, CalendarDays, PartyPopper } from 'lucide-react';
import { getCycles, type Cycle } from '@/lib/cycles';
import CycleCard from '@/components/cycles/CycleCard';
import CycleForm from '@/components/cycles/CycleForm';
import { logger } from '@/lib/logger';

interface LocationData {
  id: string;
  name: string;
  city: string;
}

export default function TrainerCycles() {
  const { t } = useTranslation('cycles');
  const { user, role, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [trainerId, setTrainerId] = useState<string | null>(null);
  const [trainerHourlyRate, setTrainerHourlyRate] = useState<number | undefined>();
  const [trainerRatingSystem, setTrainerRatingSystem] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showCreateEventDialog, setShowCreateEventDialog] = useState(false);
  const [editingCycle, setEditingCycle] = useState<Cycle | null>(null);
  const [locations, setLocations] = useState<LocationData[]>([]);

  // Auth is now handled by TrainerLayout

  useEffect(() => {
    const fetchTrainerId = async () => {
      if (!user) return;

      const { data } = await supabase
        .from('trainer_profiles')
        .select('id, hourly_rate, trainer_rating_system')
        .eq('user_id', user.id)
        .single();

      if (data) {
        setTrainerId(data.id);
        setTrainerHourlyRate(data.hourly_rate || undefined);
        setTrainerRatingSystem(data.trainer_rating_system || null);

        // Fetch trainer locations
        const { data: trainerLocs } = await supabase
          .from('trainer_locations')
          .select('location_id, locations:location_id (id, name, city)')
          .eq('trainer_id', data.id);

        if (trainerLocs) {
          setLocations(
            trainerLocs
              .filter((tl: any) => tl.locations)
              .map((tl: any) => ({
                id: tl.locations.id,
                name: tl.locations.name,
                city: tl.locations.city || '',
              }))
          );
        }
      }
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
      toast({
        title: t('common:error'),
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (trainerId) fetchCycles();
  }, [trainerId]);

  const handleCycleCreated = () => {
    setShowCreateDialog(false);
    setShowCreateEventDialog(false);
    setEditingCycle(null);
    fetchCycles();
  };

  if (loading || isLoading) {
    return (
      <div className="container mx-auto px-4 py-6">
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
    <div className="container mx-auto px-4 py-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate('/trainer')}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold">{t('registration.openCycles', 'Registrations')}</h1>
              <p className="text-muted-foreground hidden sm:block">
                {t('noRegistrationsDescription', 'Create registrations to collect player interest')}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => setShowCreateDialog(true)}>
              <Plus className="mr-2 h-4 w-4" />
              {t('createRegistration', 'Create Registration')}
            </Button>
            <Button variant="outline" onClick={() => setShowCreateEventDialog(true)}>
              <PartyPopper className="mr-2 h-4 w-4" />
              {t('createEvent', 'Create Event')}
            </Button>
          </div>
        </div>

        {/* Cycles Grid */}
        {cycles.length === 0 ? (
          <div className="text-center py-16">
            <div className="mx-auto h-16 w-16 rounded-full bg-muted flex items-center justify-center mb-4">
              <CalendarDays className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="font-semibold mb-1 text-lg">{t('noRegistrations', 'No registrations yet')}</h3>
            <p className="text-muted-foreground mb-6 max-w-md mx-auto">
              {t('noRegistrationsDescription', 'Create a registration to start collecting player interest')}
            </p>
            <Button onClick={() => setShowCreateDialog(true)}>
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
                onEdit={(c) => setEditingCycle(c)}
                onDeleted={fetchCycles}
              />
            ))}
          </div>
        )}

      {/* Create/Edit Dialog */}
      {trainerId && (
        <>
          <CycleForm
            open={showCreateDialog || (!!editingCycle && editingCycle.type !== 'event')}
            onOpenChange={(open) => {
              if (!open) {
                setShowCreateDialog(false);
                setEditingCycle(null);
              }
            }}
            cycle={editingCycle && editingCycle.type !== 'event' ? editingCycle : undefined}
            ownerType="trainer"
            ownerId={trainerId}
            trainerHourlyRate={trainerHourlyRate}
            formType="registration"
            locations={locations}
            onSuccess={handleCycleCreated}
            trainerRatingSystem={trainerRatingSystem}
          />
          <CycleForm
            open={showCreateEventDialog || (!!editingCycle && editingCycle.type === 'event')}
            onOpenChange={(open) => {
              if (!open) {
                setShowCreateEventDialog(false);
                setEditingCycle(null);
              }
            }}
            cycle={editingCycle?.type === 'event' ? editingCycle : undefined}
            ownerType="trainer"
            ownerId={trainerId}
            trainerHourlyRate={trainerHourlyRate}
            formType="event"
            locations={locations}
            onSuccess={handleCycleCreated}
            trainerRatingSystem={trainerRatingSystem}
          />
        </>
      )}
    </div>
  );
}
