import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { getAcademyTrainersWithProfiles, getAcademyLocations } from '@/lib/academy';
import { useCycleDetail } from '@/lib/cycleDetail';
import { CycleDetailView } from '@/components/cycles/CycleDetailView';
import { invalidateAllPlayerData } from '@/lib/playerQueryKeys';
import { logger } from '@/lib/logger';

type Option = { id: string; name: string };

/**
 * Academy wrapper for the shared cycle-detail centerpiece (Slice 9d). Supplies the academy role props
 * (trainer + location pickers, academy profile id, edit/price capability) and routes a session click
 * to the academy slot-detail page. A registration/event cycle isn't a training cycle, so it's sent to
 * the registration workflow at /registrations/:id.
 */
export default function AcademyCycleDetailView() {
  const { cycleId } = useParams<{ cycleId: string }>();
  const navigate = useNavigate();
  const { activeAcademy } = useAcademyContext();
  const queryClient = useQueryClient();
  const [trainers, setTrainers] = useState<Option[]>([]);
  const [locations, setLocations] = useState<Option[]>([]);

  // After ANY cycle-scope mutation in the shared view (price / roster add-swap-remove / end-date /
  // session or full-cycle delete), the affected invoices + players changed. Invalidate the academy
  // invoice list + all academy player data so they don't show stale money for up to the 60s staleTime
  // (the shared view only invalidates its own ['cycle-detail', id] query). (P2-14)
  const academyId = activeAcademy?.id;
  const handleMutated = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['academy-invoices'] });
    if (academyId) invalidateAllPlayerData(queryClient, { kind: 'academy', id: academyId });
  }, [queryClient, academyId]);

  useEffect(() => {
    if (!activeAcademy) return;
    (async () => {
      // Load trainers + locations independently so one failure doesn't hide the other picker.
      try {
        const academyTrainers = await getAcademyTrainersWithProfiles(activeAcademy.id);
        setTrainers(
          academyTrainers
            .filter((t: { status?: string; trainer_profile?: { id?: string } | null }) => t.status === 'active' && t.trainer_profile)
            .map((t: { trainer_profile?: { id?: string } | null; profile?: { full_name?: string | null } | null }) => ({
              id: t.trainer_profile!.id as string,
              name: t.profile?.full_name || 'Unknown',
            })),
        );
      } catch (e) {
        logger.error('Error loading academy trainers for cycle detail', e as Error);
      }
      try {
        const academyLocations = await getAcademyLocations(activeAcademy.id);
        setLocations(
          academyLocations
            .map((al: { location?: { id?: string; name?: string } | null }) =>
              al.location?.id ? { id: al.location.id, name: al.location.name || '' } : null,
            )
            .filter((x: Option | null): x is Option => x !== null),
        );
      } catch (e) {
        logger.error('Error loading academy locations for cycle detail', e as Error);
      }
    })();
  }, [activeAcademy]);

  const { data } = useCycleDetail(cycleId);
  const cycleType = data?.cycle?.type;
  if (cycleId && (cycleType === 'registration' || cycleType === 'event')) {
    return <Navigate to={`/app/academy/registrations/${cycleId}`} replace />;
  }
  if (!cycleId) return null;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <CycleDetailView
        cycleId={cycleId}
        canEdit
        canEditPrice
        canRemoveFromCycle
        canManageRoster
        academyProfileId={activeAcademy?.id ?? null}
        trainers={trainers}
        locations={locations}
        onOpenSlot={(slotId) => navigate(`/app/academy/slot/${slotId}`)}
        onMutated={handleMutated}
        onCycleDeleted={() => navigate('/app/academy/calendar?tab=list')}
      />
    </div>
  );
}
