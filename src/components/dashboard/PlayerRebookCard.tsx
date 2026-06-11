import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { CalendarClock, CheckCircle2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  getMyPendingPriorityClaims,
  acceptClaimWithToken,
  declineClaimWithToken,
} from '@/lib/priorityClaims';
import { formatCurrency } from '@/lib/format';

/**
 * In-app surface so a player can keep or release their priority spot for the
 * next cycle without needing the email link. "Keep" commits (no upfront
 * payment); the player is invoiced when the cycle starts. Renders nothing when
 * there are no actionable claims.
 */
export function PlayerRebookCard({ profileId }: { profileId?: string }) {
  const { t } = useTranslation('cycles');
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data: claims = [] } = useQuery({
    queryKey: ['player-rebook-claims', profileId],
    queryFn: () => getMyPendingPriorityClaims(profileId!),
    enabled: !!profileId,
  });

  if (claims.length === 0) return null;

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['player-rebook-claims', profileId] });

  const onKeep = async (token: string, id: string) => {
    setBusyId(id);
    try {
      const res = await acceptClaimWithToken(token);
      if (res?.ok) {
        toast.success(t('rebooking.toastReserved', 'Great! Your spot is reserved for the next cycle.'));
        refresh();
      } else if (res?.reason === 'slot_full') {
        toast.error(t('rebooking.errorFull', 'This spot was just filled.'));
        refresh();
      } else if (res?.reason === 'window_expired') {
        toast.error(t('rebooking.errorExpired', 'The reservation period has expired.'));
        refresh();
      } else {
        toast.error(t('rebooking.errorGeneric', 'Something went wrong. Please try again.'));
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const onRelease = async (token: string, id: string) => {
    setBusyId(id);
    try {
      await declineClaimWithToken(token, 'Player released via dashboard');
      toast.success(t('rebooking.toastReleased', 'Your spot has been released. Thanks for your response.'));
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card className="border-primary/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <CheckCircle2 className="h-5 w-5 text-primary" />
          {t('rebooking.cardTitle', 'Keep your spot?')}
        </CardTitle>
        <CardDescription>
          {t('rebooking.cardDescription', 'You have priority to keep your spot for the next cycle. You only pay when the cycle starts; the price is split between the players who join.')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {claims.map((c) => {
          const start = new Date(c.start_time);
          const end = new Date(c.end_time);
          const busy = busyId === c.id;
          return (
            <div
              key={c.id}
              className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex items-start gap-3">
                <CalendarClock className="mt-0.5 h-5 w-5 text-muted-foreground" />
                <div className="text-sm">
                  <div className="font-medium">
                    {c.cyclus_name ? `${c.cyclus_name} — ` : ''}
                    {format(start, 'EEEE d MMM')}
                  </div>
                  <div className="text-muted-foreground">
                    {format(start, 'HH:mm')} - {format(end, 'HH:mm')}
                    {c.price_per_session ? ` · ${formatCurrency(Number(c.price_per_session))} p.s.` : ''}
                  </div>
                  {c.priority_window_ends_at && (
                    <div className="text-xs text-muted-foreground">
                      {t('rebooking.respondByShort', 'Respond before {{date}}', { date: format(new Date(c.priority_window_ends_at), 'd MMM HH:mm') })}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => onKeep(c.claim_token, c.id)}>
                  {busy ? t('rebooking.working', 'Working…') : t('rebooking.keepShort', 'Keep my spot')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => onRelease(c.claim_token, c.id)}
                >
                  {t('rebooking.releaseShort', 'Release')}
                </Button>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
