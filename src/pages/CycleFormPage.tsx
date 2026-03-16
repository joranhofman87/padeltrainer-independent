import { useState, useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft } from 'lucide-react';
import { getCycle, type Cycle } from '@/lib/cycles';
import CycleForm from '@/components/cycles/CycleForm';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { useClubContext } from '@/components/club/ClubLayout';
import { getAcademyTrainersWithProfiles, getAcademyLocations } from '@/lib/academy';
import { getClubTrainers } from '@/lib/club';
import { logger } from '@/lib/logger';

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
  const { cycleId } = useParams<{ cycleId: string }>();
  const [searchParams] = useSearchParams();
  const formType = (searchParams.get('type') as 'registration' | 'event') || 'registration';
  const duplicateFromId = searchParams.get('duplicateFrom');

  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [cycle, setCycle] = useState<Cycle | null>(null);

  // Trainer-specific state
  const [trainerId, setTrainerId] = useState<string | null>(null);
  const [trainerHourlyRate, setTrainerHourlyRate] = useState<number | undefined>();
  const [trainerRatingSystem, setTrainerRatingSystem] = useState<string | null>(null);

  // Academy-specific state
  const [trainers, setTrainers] = useState<{ id: string; name: string; hourly_rate?: number }[]>([]);
  const [trainerLocationMap, setTrainerLocationMap] = useState<Record<string, string[]>>({});

  // Shared state
  const [locations, setLocations] = useState<LocationData[]>([]);

  // For academy, get context
  let activeAcademy: { id: string } | null = null;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const ctx = useAcademyContext();
    activeAcademy = ctx.activeAcademy;
  } catch {
    // Not inside AcademyLayout — that's fine for trainer
  }

  const ownerId = ownerType === 'trainer' ? trainerId : activeAcademy?.id;
  const backPath = ownerType === 'trainer' ? '/app/trainer/cycles' : '/app/academy/cycles';

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
        }

        // Load existing cycle for editing
        if (cycleId) {
          const cycleData = await getCycle(cycleId);
          setCycle(cycleData);
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
  }, [user, ownerType, activeAcademy?.id, cycleId, duplicateFromId]);

  const handleSuccess = () => {
    navigate(backPath);
  };

  const handleCancel = () => {
    navigate(backPath);
  };

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
    <div className="container mx-auto px-4 py-6 space-y-6 max-w-lg">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={handleCancel}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-2xl font-bold">{title}</h1>
      </div>

      {/* Form */}
      <CycleForm
        cycle={cycle || undefined}
        ownerType={ownerType}
        ownerId={ownerId}
        onSuccess={handleSuccess}
        onCancel={handleCancel}
        formType={formType}
        locations={locations}
        trainerHourlyRate={trainerHourlyRate}
        trainerRatingSystem={trainerRatingSystem}
        trainers={trainers}
        trainerLocationMap={trainerLocationMap}
      />
    </div>
  );
}
