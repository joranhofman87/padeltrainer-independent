import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarClock, CheckCircle2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  getMyPendingPriorityClaims,
  acceptClaimAndStartPayment,
  declineClaimWithToken,
} from '@/lib/priorityClaims';
import { formatCurrency, formatDate } from '@/lib/format';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';

/**
 * In-app surface so a player can keep or release their priority spot for the
 * next cycle without needing the email link. What "Keep" does depends on the
 * cycle's rebook_payment_mode: deferred (default) commits now and invoices at
 * cycle start; upfront sends the player straight to online checkout. Renders
 * nothing when there are no actionable claims.
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
      const res = await acceptClaimAndStartPayment(token);
      if (res?.ok) {
        if (res.mode === 'upfront' && res.checkoutUrl) {
          toast.success(t('rebooking.redirectingToPayment', 'Taking you to the payment page…'));
          window.location.href = res.checkoutUrl;
          return;
        }
        if (res.mode === 'upfront_invoiced' && res.publicToken) {
          toast.success(t('rebooking.invoiceReady', 'Your spot is reserved. Here is your invoice — pay online or by bank transfer.'));
          window.location.href = `/pay/${res.publicToken}`;
          return;
        }
        if (res.mode === 'upfront_unavailable') {
          toast.success(t('rebooking.upfrontUnavailable', 'Your spot is reserved. Online payment is not available yet — you will receive an invoice.'));
        } else {
          toast.success(t('rebooking.toastReserved', 'Great! Your spot is reserved for the next cycle.'));
        }
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
      toast.error(getFriendlyErrorMessage(e, t('rebooking.errorGeneric', 'Something went wrong. Please try again.')));
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
      toast.error(getFriendlyErrorMessage(e, t('rebooking.errorGeneric', 'Something went wrong. Please try again.')));
    } finally {
      setBusyId(null);
    }
  };

  const allUpfront = claims.every((c) => c.rebook_payment_mode === 'upfront');

  return (
    <Card className="border-primary/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <CheckCircle2 className="h-5 w-5 text-primary" />
          {t('rebooking.cardTitle', 'Keep your spot?')}
        </CardTitle>
        <CardDescription>
          {allUpfront
            ? `${t('rebooking.introNoName', 'You have priority to keep your spot for the next cycle.')} ${t('rebooking.payNow', 'You pay for the new cycle right away when you confirm your spot.')}`
            : t('rebooking.cardDescription', 'You have priority to keep your spot for the next cycle. You only pay when the cycle starts; the price is split between the players who join.')}
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
                    {c.sessions > 1
                      ? t('rebooking.seriesHeading', 'Every {{weekday}} at {{time}}', {
                          weekday: formatDate(start, 'EEEE'),
                          time: formatDate(start, 'HH:mm'),
                        })
                      : formatDate(start, 'EEEE d MMM')}
                  </div>
                  <div className="text-muted-foreground">
                    {c.sessions > 1
                      ? t('rebooking.seriesDetail', '{{count}} sessions · {{from}} to {{to}}', {
                          count: c.sessions,
                          from: formatDate(start, 'd MMM'),
                          to: formatDate(c.last_start_time, 'd MMM'),
                        })
                      : `${formatDate(start, 'HH:mm')} - ${formatDate(end, 'HH:mm')}`}
                    {c.price_per_session ? ` · ${formatCurrency(Number(c.price_per_session))} p.s.` : ''}
                  </div>
                  {c.price_per_session && c.sessions > 1 && (
                    <div className="text-xs font-medium text-foreground">
                      {t('rebooking.termTotal', '{{total}} for the full term ({{count}} sessions)', {
                        total: formatCurrency(Number(c.price_per_session) * c.sessions),
                        count: c.sessions,
                      })}
                    </div>
                  )}
                  {c.start_date && (
                    <div className="text-xs text-muted-foreground">
                      {/* start_date is a pure DATE — parse at local noon so it never shifts a day */}
                      {t('rebooking.cycleStartsShort', 'New cycle starts: {{date}}', { date: formatDate(`${c.start_date}T12:00:00`, 'd MMM yyyy') })}
                    </div>
                  )}
                  {c.priority_window_ends_at && (
                    <div className="text-xs text-muted-foreground">
                      {t('rebooking.respondByShort', 'Respond before {{date}}', { date: formatDate(c.priority_window_ends_at, 'd MMM HH:mm') })}
                    </div>
                  )}
                  {!allUpfront && c.rebook_payment_mode === 'upfront' && (
                    <div className="text-xs text-muted-foreground">
                      {t('rebooking.payNow', 'You pay for the new cycle right away when you confirm your spot.')}
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
        <div className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
          <p>{t('rebooking.cardRules', "You keep your spot until the deadline. If you don't respond, your spot is released — first to players from your current cycle, then to everyone.")}</p>
          <p>{t('rebooking.cardChangeTimes', 'Want a different time? Release your spot and book again once spots open, or contact the academy.')}</p>
          <p>{t('rebooking.cardRecovery', 'Miss the deadline? You can still book afterwards while spots last.')}</p>
        </div>
      </CardContent>
    </Card>
  );
}
