import { useState, useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft } from 'lucide-react';
import { getCycle, type Cycle } from '@/lib/cycles';
import { getRegistration } from '@/lib/registrations';
import CycleForm from '@/components/cycles/CycleForm';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { useClubContext } from '@/components/club/ClubLayout';
import { getAcademyTrainersWithProfiles, getAcademyLocations } from '@/lib/academy';
import { getClubTrainers } from '@/lib/club';
import { logger } from '@/lib/logger';
import { useQueryClient } from '@tanstack/react-query';

interface LocationData {
  id: string;
  name: string;
  city: string;
}

/**
 * Dedicated page for creating/editing a cycle (registration or event).
 * Used by both trainer and academy flows.
 *
 * Routes:
 *   /app/trainer/cycles/new?type=registration|event
 *   /app/trainer/cycles/:cycleId/edit
 *   /app/academy/cycles/new?type=registration|event
 *   /app/academy/cycles/:cycleId/edit
 */
export default function CycleFormPage({ ownerType }: { ownerType: 'trainer' | 'club' | 'academy' }) {
  const { t } = useTranslation('cycles');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { cycleId } = useParams<{ cycleId: string }>();
  const [searchParams] = useSearchParams();
  const requestedType = (searchParams.get('type') as 'registration' | 'event') || 'registration';
  const duplicateFromId = searchParams.get('duplicateFrom');

  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [cycle, setCycle] = useState<Cycle | null>(null);
  // Slice 0 (registration↔cycle split): true when the cycle being edited has been split into a
  // `registrations` row — the legacy editor is then locked so it can't diverge from the live form.
  const [formLocked, setFormLocked] = useState(false);

  // Trainer-specific state
  const [trainerId, setTrainerId] = useState<string | null>(null);
  const [trainerHourlyRate, setTrainerHourlyRate] = useState<number | undefined>();
  const [trainerRatingSystem, setTrainerRatingSystem] = useState<string | null>(null);

  // Academy-specific state
  const [trainers, setTrainers] = useState<{ id: string; name: string; hourly_rate?: number }[]>([]);
  const [trainerLocationMap, setTrainerLocationMap] = useState<Record<string, string[]>>({});

  // Shared state
  const [locations, setLocations] = useState<LocationData[]>([]);

  // For academy/club, get context
  let activeAcademy: { id: string } | null = null;
  let activeClub: { id: string; location_id: string } | null = null;
  try {
     
    const ctx = useAcademyContext();
    activeAcademy = ctx.activeAcademy;
  } catch {
    // Not inside AcademyLayout
  }
  try {
     
    const ctx = useClubContext();
    activeClub = ctx.activeClub;
  } catch {
    // Not inside ClubLayout
  }

  const ownerId = ownerType === 'trainer' ? trainerId : ownerType === 'academy' ? activeAcademy?.id : activeClub?.id;
  // After editing an academy cycle, return to that cycle's detail page (where
  // the editor was opened from); creating/duplicating returns to the list.
  const backPath =
    ownerType === 'trainer'
      ? '/app/trainer/cycles'
      : ownerType === 'academy'
        ? cycleId
          ? `/app/academy/cycles/${cycleId}`
          : '/app/academy/registrations'
        : '/app/club/registrations';

  // Fetch owner data
  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      try {
        if (ownerType === 'trainer' && user) {
          const { data } = await supabase
            .from('trainer_profiles')
            .select('id, hourly_rate, trainer_rating_system')
            .eq('user_id', user.id)
            .single();

          if (data) {
            setTrainerId(data.id);
            setTrainerHourlyRate(data.hourly_rate || undefined);
            setTrainerRatingSystem(data.trainer_rating_system || null);

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
        } else if (ownerType === 'academy' && activeAcademy) {
          const [academyTrainers, academyLocations] = await Promise.all([
            getAcademyTrainersWithProfiles(activeAcademy.id),
            getAcademyLocations(activeAcademy.id),
          ]);

          const trainerIds = academyTrainers.map(t => t.trainer_profile_id);
          const tlMap: Record<string, string[]> = {};
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
          setTrainers(
            academyTrainers.map((t) => ({
              id: t.trainer_profile_id,
              name: t.profile?.full_name || 'Unknown',
              hourly_rate: t.trainer_profile?.hourly_rate || undefined,
            }))
          );
          setLocations(
            academyLocations
              .filter((l) => l.location)
              .map((l) => ({
                id: l.location!.id,
                name: l.location!.name,
                city: l.location!.city || '',
              }))
          );
        } else if (ownerType === 'club' && activeClub) {
          // Fetch club trainers and location
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
              .eq('id', trainer.user_id)
              .single();
            trainerList.push({
              id: trainer.id,
              name: profile?.full_name || 'Unknown',
              hourly_rate: trainer.hourly_rate || undefined,
            });
          }
          setTrainers(trainerList);

          // Club location
          const { data: locData } = await supabase
            .from('locations')
            .select('id, name, city')
            .eq('id', activeClub.location_id)
            .single();
          if (locData) {
            setLocations([{ id: locData.id, name: locData.name, city: locData.city || '' }]);
          }

          // Trainer-location map
          const tlMap: Record<string, string[]> = {};
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
        }

        // Load existing cycle for editing
        if (cycleId) {
          const cycleData = await getCycle(cycleId);
          setCycle(cycleData);
          // Lock the legacy editor if this cycle's form now lives in the registrations table
          // (resolves by id OR source_cycle_id). A duplicate (else-branch) is a new cycle → unlocked.
          const reg = await getRegistration(cycleId);
          setFormLocked(!!reg);
        } else if (duplicateFromId) {
          const cycleData = await getCycle(duplicateFromId);
          if (cycleData) {
            setCycle({
              ...cycleData,
              id: '', // Will be generated
              name: `${cycleData.name} (${t('common:copy', 'Copy')})`,
              status: 'draft',
            });
          }
        }
      } catch (error) {
        logger.error('Error loading cycle form data', error as Error, { component: 'CycleFormPage' });
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [user, ownerType, activeAcademy?.id, activeClub?.id, cycleId, duplicateFromId]);

  const handleSuccess = () => {
    // The cycle-detail query is cached (staleTime 60s); invalidate it so the
    // detail page we return to reflects the just-saved changes.
    if (cycleId) queryClient.invalidateQueries({ queryKey: ['cycle-detail', cycleId] });
    navigate(backPath);
  };

  const handleCancel = () => {
    navigate(backPath);
  };

  // When editing an existing cycle the type comes from the cycle itself (the
  // edit route carries no ?type=); fall back to the requested type when creating.
  const formType: 'registration' | 'event' =
    cycleId && cycle ? (cycle.type === 'event' ? 'event' : 'registration') : requestedType;

  const title = cycleId
    ? formType === 'event' ? t('editEvent', 'Edit Event') : t('editRegistration', 'Edit Registration')
    : formType === 'event' ? t('createEvent', 'Create Event') : t('createRegistration', 'Create Registration');

  if (isLoading || !ownerId) {
    return (
      <div className="container mx-auto px-4 py-6 space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 space-y-6 max-w-2xl">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" aria-label="Go back" onClick={handleCancel}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-2xl font-bold">{title}</h1>
      </div>

      {/* Form */}
      <CycleForm
        // Remount per cycle so navigating between edit pages (SPA, same route) re-initialises the
        // form from the new cycle's defaultValues — the legacy `if (open)` reset effect is dead in
        // this full-page editor (kept dead on purpose: it clobbered manual dates, #44), so without a
        // key the form would show the previous cycle's stale values.
        key={cycleId ?? 'new'}
        cycle={cycle || undefined}
        ownerType={ownerType}
        ownerId={ownerId}
        onSuccess={handleSuccess}
        onCancel={handleCancel}
        formType={formType}
        locked={formLocked}
        locations={locations}
        trainerHourlyRate={trainerHourlyRate}
        trainerRatingSystem={trainerRatingSystem}
        trainers={trainers}
        trainerLocationMap={trainerLocationMap}
      />
    </div>
  );
}
