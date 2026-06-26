import { useEffect, useState } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/hooks/useAuth';
import { useCycleDetail } from '@/lib/cycleDetail';
import { CycleDetailView } from '@/components/cycles/CycleDetailView';

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
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      const { data: tp } = await supabase.from('trainer_profiles').select('id').eq('user_id', user.id).single();
      if (!tp) return;
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
      />
    </div>
  );
}
