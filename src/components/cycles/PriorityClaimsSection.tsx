import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Clock, X, Globe } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import {
  getPriorityClaimsForSlot,
  declineClaimAsManager,
  endPriorityWindowNow,
  extendPriorityWindow,
  type ClaimStatus,
} from '@/lib/priorityClaims';

interface Props {
  slotId: string;
  onChange?: () => void;
}

interface ClaimRow {
  id: string;
  status: ClaimStatus;
  claim_token: string;
  responded_at: string | null;
  profiles: { id: string; full_name: string | null; email: string | null } | null;
  guest_players: { id: string; full_name: string | null; email: string | null } | null;
}

const statusVariant: Record<ClaimStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  pending: 'secondary',
  claimed: 'default',
  declined: 'outline',
  expired: 'outline',
  released: 'outline',
};

export default function PriorityClaimsSection({ slotId, onChange }: Props) {
  const { t } = useTranslation('cycles');
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [priorityWindowEndsAt, setPriorityWindowEndsAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = async () => {
    setLoading(true);
    try {
      const [claimsData, slot] = await Promise.all([
        getPriorityClaimsForSlot(slotId),
        supabase.from('availability_slots').select('priority_window_ends_at').eq('id', slotId).maybeSingle(),
      ]);
      setClaims(claimsData as unknown as ClaimRow[]);
      setPriorityWindowEndsAt(slot.data?.priority_window_ends_at ?? null);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, [slotId]);

  if (loading) return null;
  if (claims.length === 0 && !priorityWindowEndsAt) return null;

  const windowEnded = priorityWindowEndsAt && new Date(priorityWindowEndsAt) < new Date();

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-base">{t('priorityClaims.title', 'Priority rebooking')}</CardTitle>
          {priorityWindowEndsAt && (
            <Badge variant={windowEnded ? 'outline' : 'secondary'} className="gap-1">
              <Clock className="h-3 w-3" />
              {windowEnded
                ? t('priorityClaims.ended', 'Window ended')
                : t('priorityClaims.endsAt', { date: new Date(priorityWindowEndsAt).toLocaleString(), defaultValue: 'Ends {{date}}' })}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {claims.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('priorityClaims.empty', 'No priority players assigned to this slot.')}</p>
        ) : (
          <div className="space-y-2">
            {claims.map((c) => {
              const name = c.profiles?.full_name || c.guest_players?.full_name || c.profiles?.email || c.guest_players?.email || '—';
              return (
                <div key={c.id} className="flex items-center justify-between gap-2 border rounded p-2">
                  <div>
                    <div className="text-sm font-medium">{name}</div>
                    <div className="text-xs text-muted-foreground">{c.profiles?.email || c.guest_players?.email}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={statusVariant[c.status]}>{c.status}</Badge>
                    {c.status === 'pending' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={async () => {
                          try {
                            await declineClaimAsManager(c.id);
                            await reload();
                            onChange?.();
                          } catch (e) { toast.error((e as Error).message); }
                        }}
                      >
                        <X className="h-4 w-4 mr-1" /> {t('priorityClaims.release', 'Release')}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {priorityWindowEndsAt && !windowEnded && (
          <div className="flex flex-wrap gap-2 pt-2">
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                try { await extendPriorityWindow(slotId, 7); toast.success('Extended by 7 days'); onChange?.(); }
                catch (e) { toast.error((e as Error).message); }
              }}
            >
              + 7 {t('priorityClaims.days', 'days')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                try { await endPriorityWindowNow(slotId); toast.success('Opened to public'); onChange?.(); }
                catch (e) { toast.error((e as Error).message); }
              }}
            >
              <Globe className="h-4 w-4 mr-1" /> {t('priorityClaims.openNow', 'Open to public now')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
