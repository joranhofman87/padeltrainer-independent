import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/hooks/useAuth';
import { useCycleDetail } from '@/lib/cycleDetail';
import { CycleDetailView } from '@/components/cycles/CycleDetailView';
import { invalidateAllPlayerData } from '@/lib/playerQueryKeys';

/**
 * Trainer wrapper for the shared cycle-detail centerpiece (Slice 9d). Self-only: no trainer picker
 * and no academy profile id; locations come from the trainer's own used locations. A session click
 * opens the trainer slot-detail page. A registration/event isn't a training cycle, so it's sent back
 * to the trainer cycles list.
 */
export default function TrainerCycleDetailView() {
  const { cycleId } = useParams<{ cycleId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [trainerId, setTrainerId] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      const { data: tp } = await supabase.from('trainer_profiles').select('id').eq('user_id', user.id).single();
      if (!tp) return;
      // Capture the trainer id before the location early-returns so onMutated can invalidate the
      // trainer invoice + player caches even for a trainer with no located slots. (P2-14)
      setTrainerId(tp.id);
      const { data: slots } = await supabase
        .from('availability_slots')
        .select('location_id')
        .eq('trainer_id', tp.id)
        .not('location_id', 'is', null);
      const locIds = [...new Set((slots || []).map((s) => s.location_id).filter(Boolean))] as string[];
      if (locIds.length === 0) return;
      const { data: locs } = await supabase.from('locations').select('id, name').in('id', locIds);
      setLocations((locs || []).map((l) => ({ id: l.id, name: l.name })));
    })();
  }, [user?.id]);

  // After ANY cycle-scope mutation in the shared view (price / roster / end-date / delete), refresh
  // the trainer invoice list + all trainer player data so they don't show stale money for up to the
  // 60s staleTime (the shared view only invalidates its own ['cycle-detail', id] query). (P2-14)
  const handleMutated = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['trainer-invoices'] });
    if (trainerId) invalidateAllPlayerData(queryClient, { kind: 'trainer', id: trainerId });
  }, [queryClient, trainerId]);

  const { data } = useCycleDetail(cycleId);
  const cycleType = data?.cycle?.type;
  if (cycleId && (cycleType === 'registration' || cycleType === 'event')) {
    return <Navigate to="/app/trainer/cycles" replace />;
  }
  if (!cycleId) return null;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <CycleDetailView
        cycleId={cycleId}
        canEdit
        canEditPrice
        locations={locations}
        onOpenSlot={(slotId) => navigate(`/app/trainer/slot/${slotId}`)}
        onMutated={handleMutated}
        onCycleDeleted={() => navigate('/app/trainer/cycles')}
      />
    </div>
  );
}
