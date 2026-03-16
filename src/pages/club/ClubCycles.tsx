import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Plus, CalendarDays, PartyPopper } from 'lucide-react';
import { getCyclesWithCounts, type Cycle } from '@/lib/cycles';
import CyclesTable from '@/components/cycles/CyclesTable';
import { useClubContext } from '@/components/club/ClubLayout';
import { getClubTrainers } from '@/lib/club';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';

interface LocationData {
  id: string;
  name: string;
  city: string;
}

export default function ClubCycles() {
  const { t } = useTranslation('cycles');
  const { toast } = useToast();
  const navigate = useNavigate();
  const { activeClub } = useClubContext();

  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // Dialog state removed — using dedicated pages now
  const [trainers, setTrainers] = useState<{ id: string; name: string; hourly_rate?: number }[]>([]);
  const [locations, setLocations] = useState<LocationData[]>([]);
  const [trainerLocationMap, setTrainerLocationMap] = useState<Record<string, string[]>>({});

  // Fetch club trainers and location for the form
  useEffect(() => {
    const fetchData = async () => {
      if (!activeClub) return;
      try {
        // Get trainers
        const clubTrainers = await getClubTrainers(activeClub.id);
        const trainerList: { id: string; name: string; hourly_rate?: number }[] = [];
        const trainerIds: string[] = [];

        for (const ct of clubTrainers) {
          const trainer = ct.trainer_profiles as any;
          if (!trainer) continue;
          trainerIds.push(trainer.id);
          const { data: profile } = await supabase
            .from('profiles')
            .select('full_name')
            .eq('user_id', trainer.user_id)
            .single();
          trainerList.push({
            id: trainer.id,
            name: profile?.full_name || 'Unknown',
            hourly_rate: trainer.hourly_rate || undefined,
          });
        }
        setTrainers(trainerList);

        // Club has a single location
        const clubLocation = activeClub.location;
        if (clubLocation) {
          setLocations([{
            id: clubLocation.id,
            name: clubLocation.name,
            city: clubLocation.city || '',
          }]);
        }

        // Fetch trainer-location mappings
        let tlMap: Record<string, string[]> = {};
        if (trainerIds.length > 0) {
          const { data: trainerLocs } = await supabase
            .from('trainer_locations')
            .select('trainer_id, location_id')
            .in('trainer_id', trainerIds);

          if (trainerLocs) {
            for (const tl of trainerLocs) {
              if (!tlMap[tl.location_id]) tlMap[tl.location_id] = [];
              tlMap[tl.location_id].push(tl.trainer_id);
            }
          }
        }
        setTrainerLocationMap(tlMap);
      } catch (error) {
        logger.error('Error fetching club data', error as Error, { component: 'ClubCycles', clubId: activeClub?.id });
      }
    };
    fetchData();
  }, [activeClub]);

  const fetchCycles = async () => {
    if (!activeClub) return;

    setIsLoading(true);
    try {
      const data = await getCyclesWithCounts('club', activeClub.id);
      setCycles(data);
    } catch (error: any) {
      logger.error('Error fetching cycles', error as Error, { component: 'ClubCycles', clubId: activeClub?.id });
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
    if (activeClub) fetchCycles();
  }, [activeClub]);

  const handleCycleCreated = () => {
    fetchCycles();
  };

  const handleDuplicate = (cycle: Cycle) => {
    navigate(`/app/club/registrations/new?type=registration&duplicateFrom=${cycle.id}`);
  };

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-6">
        <Skeleton className="h-8 w-48 mb-6" />
        <Skeleton className="h-12 w-full mb-4" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{t('registration.openCycles', 'Registrations')}</h1>
          <p className="text-muted-foreground hidden sm:block">
            {t('noRegistrationsDescription', 'Create registrations to collect player interest')}
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => navigate('/app/club/registrations/new?type=registration')}>
            <Plus className="mr-2 h-4 w-4" />
            {t('createRegistration', 'Create Registration')}
          </Button>
          <Button variant="outline" onClick={() => navigate('/app/club/registrations/new?type=event')}>
            <PartyPopper className="mr-2 h-4 w-4" />
            {t('createEvent', 'Create Event')}
          </Button>
        </div>
      </div>

      {/* Cycles Table or Empty State */}
      {cycles.length === 0 ? (
        <div className="text-center py-16">
          <div className="mx-auto h-16 w-16 rounded-full bg-muted flex items-center justify-center mb-4">
            <CalendarDays className="h-8 w-8 text-muted-foreground" />
          </div>
          <h3 className="font-semibold mb-1 text-lg">{t('noRegistrations', 'No registrations yet')}</h3>
          <p className="text-muted-foreground mb-6 max-w-md mx-auto">
            {t('noRegistrationsDescription', 'Create a registration to start collecting player interest')}
          </p>
          <Button onClick={() => navigate('/app/club/registrations/new?type=registration')}>
            <Plus className="mr-2 h-4 w-4" />
            {t('createRegistration', 'Create Registration')}
          </Button>
        </div>
      ) : (
        <CyclesTable
          cycles={cycles}
          locations={locations}
          onEdit={(c) => setEditingCycle(c)}
          onDuplicate={handleDuplicate}
          onDeleted={fetchCycles}
          ownerType="club"
          ownerSlug={activeClub.id}
        />
      )}

      {/* Create/Edit Dialog */}
      {activeClub && (
        <>
          <CycleForm
            open={showCreateDialog || (!!editingCycle && editingCycle.type !== 'event')}
            onOpenChange={(open) => {
              if (!open) {
                setShowCreateDialog(false);
                setEditingCycle(null);
              }
            }}
            cycle={editingCycle && editingCycle.id && editingCycle.type !== 'event' ? editingCycle : undefined}
            ownerType="club"
            ownerId={activeClub.id}
            onSuccess={handleCycleCreated}
            formType="registration"
            trainers={trainers}
            locations={locations}
            trainerLocationMap={trainerLocationMap}
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
            ownerType="club"
            ownerId={activeClub.id}
            onSuccess={handleCycleCreated}
            formType="event"
            trainers={trainers}
            locations={locations}
            trainerLocationMap={trainerLocationMap}
          />
        </>
      )}
    </div>
  );
}
