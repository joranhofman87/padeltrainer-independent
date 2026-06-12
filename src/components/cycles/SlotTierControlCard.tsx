import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Users, Globe, Lock, Eye } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { formatDate } from '@/lib/format';
import {
  openSlotToMembersNow,
  releaseSlotToPublic,
  holdSlotForReview,
  setSlotToPendingReview,
  type PublicReleaseStatus,
  type SlotTier,
  getSlotVisibility,
} from '@/lib/priorityClaims';

interface Props {
  slotId: string;
  onChange?: () => void;
}

interface SlotRow {
  id: string;
  priority_window_ends_at: string | null;
  member_window_ends_at: string | null;
  public_release_status: PublicReleaseStatus | null;
  source_cycle_id: string | null;
}

const tierVariant: Record<SlotTier, 'default' | 'secondary' | 'outline'> = {
  priority: 'secondary',
  members: 'secondary',
  public: 'default',
  hidden: 'outline',
};

// Humanized labels for the raw public_release_status enum — never render the DB value.
const releaseStatusLabel: Record<PublicReleaseStatus, { key: string; defaultValue: string }> = {
  pending_admin_review: { key: 'tierControl.releaseStatusValue.pending_admin_review', defaultValue: 'Awaiting review' },
  auto_release_scheduled: { key: 'tierControl.releaseStatusValue.auto_release_scheduled', defaultValue: 'Automatic release scheduled' },
  released: { key: 'tierControl.releaseStatusValue.released', defaultValue: 'Released' },
  held: { key: 'tierControl.releaseStatusValue.held', defaultValue: 'Held for review' },
};

export default function SlotTierControlCard({ slotId, onChange }: Props) {
  const { t } = useTranslation('cycles');
  const [slot, setSlot] = useState<SlotRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('availability_slots')
      .select('id, priority_window_ends_at, member_window_ends_at, public_release_status, source_cycle_id')
      .eq('id', slotId)
      .maybeSingle();
    setSlot((data as unknown) as SlotRow);
    setLoading(false);
  };
  useEffect(() => { reload(); }, [slotId]);

  if (loading || !slot) return null;
  // Only show if slot is part of the rebooking flow
  if (!slot.source_cycle_id && !slot.priority_window_ends_at && !slot.member_window_ends_at) return null;

  // Determine current tier by treating viewer as a member-eligible viewer for display purposes
  const tier: SlotTier = getSlotVisibility({
    slotId: slot.id,
    priorityWindowEndsAt: slot.priority_window_ends_at,
    hasPendingPriority: false, // owner doesn't need priority detail; we surface windows below
    hasReleasedSeat: false,
    memberWindowEndsAt: slot.member_window_ends_at,
    publicReleaseStatus: slot.public_release_status ?? 'auto_release_scheduled',
    isCycleMember: true,
  });

  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); await reload(); onChange?.(); }
    catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-base">{t('tierControl.title', 'Visibility & rebooking')}</CardTitle>
          <Badge variant={tierVariant[tier]}>
            {t(`tierControl.tier.${tier}`, tier)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-xs text-muted-foreground space-y-1">
          {slot.priority_window_ends_at && (
            <div>{t('tierControl.priorityEnds', 'Priority window ends')}: {formatDate(slot.priority_window_ends_at, 'd MMM yyyy HH:mm')}</div>
          )}
          {slot.member_window_ends_at && (
            <div>{t('tierControl.memberEnds', 'Member window ends')}: {formatDate(slot.member_window_ends_at, 'd MMM yyyy HH:mm')}</div>
          )}
          {(() => {
            const status = releaseStatusLabel[slot.public_release_status ?? 'auto_release_scheduled'];
            return <div>{t('tierControl.releaseStatus', 'Release status')}: {t(status.key, status.defaultValue)}</div>;
          })()}
        </div>

        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => wrap(() => openSlotToMembersNow(slotId, 7))}>
            <Users className="h-4 w-4 mr-1" /> {t('tierControl.openMembers', 'Open to members now')}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => wrap(() => releaseSlotToPublic(slotId))}>
            <Globe className="h-4 w-4 mr-1" /> {t('tierControl.openPublic', 'Open to public now')}
          </Button>
          {slot.public_release_status === 'held' ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => wrap(() => setSlotToPendingReview(slotId))}>
              <Eye className="h-4 w-4 mr-1" /> {t('tierControl.unhold', 'Move to review')}
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => wrap(() => holdSlotForReview(slotId))}>
              <Lock className="h-4 w-4 mr-1" /> {t('tierControl.hold', 'Hold for review')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
