import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { CalendarClock, MapPin, CheckCircle2, XCircle } from 'lucide-react';
import {
  fetchClaimByToken,
  fetchRebookGroupByToken,
  declineClaimWithToken,
  acceptClaimAndStartPayment,
  createGroupRebookInvoice,
  sendRebookGroupConfirmations,
  getCycleRebookPaymentMode,
  getCycleStartDate,
  type RebookPaymentMode,
  type RebookGroup,
  type RebookGroupApplyResult,
} from '@/lib/priorityClaims';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { formatCurrency, formatDate } from '@/lib/format';
import { QueryErrorState } from '@/components/ui/QueryErrorState';
import { RebookGroupEditor } from '@/components/cycles/RebookGroupEditor';

interface ClaimData {
  claim: {
    id: string;
    status: string;
    claim_token: string;
  };
  slot: {
    id: string;
    start_time: string;
    end_time: string;
    cyclus_id: string | null;
    cyclus_name: string | null;
    location_id: string | null;
    price_per_session: number | null;
    total_price: number | null;
    priority_window_ends_at: string | null;
    trainer_id: string;
  };
  // Number of weekly sessions in this player's rebook series (term length).
  sessions: number | null;
  player_name: string | null;
  // First name of the group member who re-booked this spot on the viewer's behalf, else null.
  booked_by_captain_name: string | null;
}

export default function PriorityClaimPage() {
  const { t } = useTranslation('cycles');
  const { token } = useParams<{ token: string }>();
  const [searchParams] = useSearchParams();
  const intent = searchParams.get('intent'); // 'accept' | 'decline' from the email buttons
  const [data, setData] = useState<ClaimData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [acting, setActing] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [paymentMode, setPaymentMode] = useState<RebookPaymentMode>('deferred_split');
  const [cycleStartDate, setCycleStartDate] = useState<string | null>(null);
  const [group, setGroup] = useState<RebookGroup | null>(null);
  // null = claim card; 'apply' = deferred group editor; 'manage' = post-payment roster editor.
  const [groupMode, setGroupMode] = useState<'apply' | 'manage' | null>(null);

  const loadClaim = useCallback(() => {
    if (!token) return;
    setLoading(true);
    setLoadFailed(false);
    setGroupMode(null);
    fetchClaimByToken(token)
      // A null result is a definitive "no such claim"; a throw is a failed
      // request (network/5xx) — the link may still be valid, so offer a retry.
      .then(async (res) => {
        const claim = res as unknown as ClaimData | null;
        setData(claim);
        // Mode-aware copy + "starts on" date + the group roster (for the "re-book the
        // whole group" option): read in parallel; each falls back gracefully.
        const [mode, startDate, grp] = await Promise.all([
          getCycleRebookPaymentMode(claim?.slot?.cyclus_id),
          getCycleStartDate(claim?.slot?.cyclus_id),
          fetchRebookGroupByToken(token).catch(() => null),
        ]);
        setPaymentMode(mode);
        setCycleStartDate(startDate);
        setGroup(grp);
      })
      .catch(() => setLoadFailed(true))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    loadClaim();
  }, [loadClaim]);

  const onClaim = async () => {
    if (!token) return;
    setActing(true);
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
        if (res.mode === 'strict_mollie_unavailable') {
          // Strict: no seat is held without payment — the hold was released. Do NOT mark accepted.
          toast.error(t('rebooking.strictMollieUnavailable', 'We couldn’t start the online payment, so no spot was reserved. Please try again.'));
          return;
        }
        setAccepted(true);
        if (res.mode === 'upfront_unavailable') {
          toast.success(t('rebooking.upfrontUnavailable', 'Your spot is reserved. Online payment is not available yet — you will receive an invoice.'));
        } else {
          toast.success(t('rebooking.toastReserved', 'Great! Your spot is reserved for the next cycle.'));
        }
      } else if (res?.reason === 'slot_full') {
        toast.error(t('rebooking.errorFull', 'This spot was just filled.'));
      } else if (res?.reason === 'window_expired') {
        toast.error(t('rebooking.errorExpired', 'The reservation period has expired.'));
      } else if (res?.reason === 'already_responded') {
        toast.info(t('rebooking.errorAlready', 'You have already responded to this invitation.'));
        setAccepted(true);
      } else {
        toast.error(t('rebooking.errorGeneric', 'Something went wrong. Please try again.'));
      }
    } catch (e) {
      toast.error(getFriendlyErrorMessage(e, t('rebooking.errorGeneric', 'Something went wrong. Please try again.')));
    } finally {
      setActing(false);
    }
  };

  const onDecline = async () => {
    if (!token) return;
    setActing(true);
    try {
      await declineClaimWithToken(token, 'Player declined via priority link');
      setDeclined(true);
      toast.success(t('rebooking.toastReleased', 'Your spot has been released. Thanks for your response.'));
    } catch (e) {
      toast.error(getFriendlyErrorMessage(e, t('rebooking.errorGeneric', 'Something went wrong. Please try again.')));
    } finally {
      setActing(false);
    }
  };

  // UPFRONT pay-first: book ONLY the captain's seat + mint one group invoice (full court
  // price) + go to checkout. The captain assigns the roster AFTER paying (manage mode).
  const onUpfrontGroupPay = async () => {
    if (!token) return;
    setActing(true);
    try {
      const res = await createGroupRebookInvoice(token);
      if (res.ok && res.checkoutUrl) {
        toast.success(t('rebooking.redirectingToPayment', 'Taking you to the payment page…'));
        window.location.href = res.checkoutUrl;
        return;
      }
      if (res.ok && res.publicToken) {
        toast.success(t('rebooking.invoiceReady', 'Your spot is reserved. Here is your invoice — pay online or by bank transfer.'));
        window.location.href = `/pay/${res.publicToken}`;
        return;
      }
      if (res.reason === 'already_responded') {
        toast.info(t('rebooking.errorAlready', 'You have already responded to this invitation.'));
        loadClaim();
        return;
      }
      if (res.reason === 'window_expired') {
        toast.error(t('rebooking.errorExpired', 'The reservation period has expired.'));
        return;
      }
      if (res.reason === 'strict_mollie_unavailable') {
        // Strict group: no seats held without an online payment — the holds were released.
        toast.error(t('rebooking.strictMollieUnavailable', 'We couldn’t start the online payment, so no spot was reserved. Please try again.'));
        return;
      }
      toast.error(t('rebooking.errorGeneric', 'Something went wrong. Please try again.'));
    } catch (e) {
      toast.error(getFriendlyErrorMessage(e, t('rebooking.errorGeneric', 'Something went wrong. Please try again.')));
    } finally {
      setActing(false);
    }
  };

  // Captain re-booked / managed the whole group. Deferred = each player billed their own share
  // at cycle start; manage = the booked members are covered by the captain's upfront payment.
  const onGroupDone = (res: RebookGroupApplyResult) => {
    const wasManage = groupMode === 'manage';
    setGroupMode(null);
    if (res.ok) {
      setAccepted(true);
      toast.success(
        wasManage
          ? t('rebookGroup.doneManage', 'Je groep is opgeslagen. Iedereen is ingeschreven en valt onder jouw betaling.')
          : paymentMode === 'upfront'
            ? t('rebookGroup.doneUpfront', 'Je groep is opnieuw ingeschreven. Je ontvangt één factuur voor de hele groep.')
            : t('rebookGroup.done', 'Je groep is opnieuw ingeschreven. Iedereens plek is gereserveerd.'));
      // Notify everyone the captain just booked (fire-and-forget; idempotent server-side).
      if (token) sendRebookGroupConfirmations(token);
      // Refresh so can_manage_group + the latest roster are reflected on return.
      loadClaim();
    }
  };

  if (loading) {
    return (
      <div className="container max-w-xl mx-auto py-12 px-4">
        <Skeleton className="h-8 w-48 mb-4" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (loadFailed) {
    return (
      <div className="container max-w-xl mx-auto py-16 px-4">
        <Helmet><meta name="robots" content="noindex" /></Helmet>
        <QueryErrorState
          onRetry={loadClaim}
          title={t('rebooking.loadFailedTitle', 'Could not load this page')}
          description={t('rebooking.loadFailedDescription', 'Something went wrong while loading your invitation. Your link is still valid and your spot has not been released — check your connection and try again.')}
        />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="container max-w-xl mx-auto py-16 px-4 text-center">
        <Helmet><meta name="robots" content="noindex" /></Helmet>
        <h1 className="text-2xl font-bold mb-2">{t('rebooking.linkInvalid', 'Link not found')}</h1>
        <p className="text-muted-foreground">{t('rebooking.linkInvalidDescription', 'This claim link is invalid or has expired.')}</p>
      </div>
    );
  }

  const windowEnded = data.slot.priority_window_ends_at && new Date(data.slot.priority_window_ends_at) < new Date();
  const status = data.claim.status;
  const start = new Date(data.slot.start_time);
  const end = new Date(data.slot.end_time);
  // The player can still keep/release → show the "how it works" explainer.
  const actionable = !accepted && !declined && status !== 'claimed' && status !== 'declined' && !windowEnded;

  // Captain editor takes over the card body when re-booking the whole group.
  if (groupMode && group && token) {
    return (
      <div className="container max-w-xl mx-auto py-12 px-4">
        <Helmet><title>{t('rebookGroup.title', 'Schrijf je groep opnieuw in')}</title><meta name="robots" content="noindex" /></Helmet>
        <Card>
          <CardHeader>
            <CardTitle>{data.slot.cyclus_name ?? t('rebookGroup.title', 'Schrijf je groep opnieuw in')}</CardTitle>
          </CardHeader>
          <CardContent>
            <RebookGroupEditor
              token={token}
              group={group}
              paymentMode={paymentMode}
              mode={groupMode}
              invoiceId={group.group_invoice_id ?? undefined}
              onBack={() => setGroupMode(null)}
              onDone={onGroupDone}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container max-w-xl mx-auto py-12 px-4">
      <Helmet><title>{t('rebooking.title', 'Keep your spot?')}</title><meta name="robots" content="noindex" /></Helmet>

      <Card>
        <CardHeader>
          <CardTitle>{data.slot.cyclus_name ?? t('rebooking.title', 'Keep your spot?')}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {data.player_name
              ? t('rebooking.intro', '{{name}}, you have priority to keep your spot for the next cycle.', { name: data.player_name })
              : t('rebooking.introNoName', 'You have priority to keep your spot for the next cycle.')}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-3">
            <CalendarClock className="h-5 w-5 mt-0.5 text-muted-foreground" />
            <div>
              <div className="font-medium">{formatDate(start, 'EEEE d MMMM yyyy')}</div>
              <div className="text-sm text-muted-foreground">{formatDate(start, 'HH:mm')} - {formatDate(end, 'HH:mm')}</div>
            </div>
          </div>
          {cycleStartDate && (
            <p className="text-sm text-muted-foreground">
              {/* start_date is a pure DATE — parse at local noon so it never shifts a day */}
              {t('rebooking.cycleStarts', 'The new cycle starts on {{date}}.', { date: formatDate(`${cycleStartDate}T12:00:00`, 'd MMMM yyyy') })}
            </p>
          )}
          {data.slot.price_per_session && (
            <div className="flex items-start gap-3">
              <MapPin className="h-5 w-5 mt-0.5 text-muted-foreground" />
              <div className="text-sm">
                <div>{t('rebooking.perSession', '{{amount}} per session', { amount: formatCurrency(Number(data.slot.price_per_session)) })}</div>
                {(data.sessions ?? 1) > 1 && (
                  <div className="font-medium text-foreground">
                    {t('rebooking.termTotal', '{{total}} for the full term ({{count}} sessions)', {
                      total: formatCurrency(Number(data.slot.price_per_session) * (data.sessions ?? 1)),
                      count: data.sessions ?? 1,
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
          {data.slot.price_per_session && (
            <p className="text-xs text-muted-foreground">
              {paymentMode === 'upfront'
                ? t('rebooking.payNow', 'You pay for the new cycle right away when you confirm your spot.')
                : t('rebooking.payLater', 'You only pay when the cycle starts; the price is split between the players who join.')}
            </p>
          )}
          {data.slot.price_per_session && paymentMode === 'deferred_split' && (
            <p className="text-xs text-muted-foreground">
              {t('rebooking.splitNote', 'The price is shared between everyone who joins, so if fewer players sign up, each person pays a bit more.')}
            </p>
          )}
          {data.slot.priority_window_ends_at && !windowEnded && (
            <p className="text-sm text-muted-foreground">
              {t('rebooking.respondBefore', 'Respond before {{date}}.', { date: formatDate(data.slot.priority_window_ends_at, 'd MMM yyyy HH:mm') })}
            </p>
          )}

          {actionable && (
            <div className="rounded-lg bg-muted/50 p-3 space-y-2 text-sm">
              <p className="font-medium">{t('rebooking.rulesTitle', 'How does it work?')}</p>
              <p className="text-muted-foreground">
                {data.slot.priority_window_ends_at
                  ? t('rebooking.ruleKeep', 'You keep your spot until the deadline above.')
                  : t('rebooking.ruleKeepNoDeadline', 'You keep your spot while the priority period is open.')}
                {' '}
                {t('rebooking.ruleAfter', "If you don't respond in time, your spot is released afterwards: first to other players from your current cycle, then to everyone.")}
              </p>
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">{t('rebooking.changeTimesTitle', 'Want a different time?')}</span>{' '}
                {t('rebooking.changeTimesBody', 'You keep your own day and time. To switch, release your spot and book again once spots open, or contact the academy.')}
              </p>
              <p className="text-muted-foreground">
                {t('rebooking.ifNoResponse', "No response means your spot is released after the deadline. You can still book afterwards via ‘Browse available spots’ while spots last.")}
              </p>
            </div>
          )}

          {accepted || status === 'claimed' ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-green-600">
                <CheckCircle2 className="h-5 w-5" />
                {group?.can_manage_group
                  ? t('rebookGroup.paidManagePrompt', 'Betaling ontvangen — je plek is gereserveerd. Stel hieronder je groep samen.')
                  : !accepted && data.booked_by_captain_name
                    ? t('rebookGroup.bookedByCaptain', '{{name}} heeft je groep al opnieuw ingeschreven — je doet mee. Je plek is gereserveerd.', { name: data.booked_by_captain_name })
                    : t('rebooking.reserved', "Your spot is reserved. You'll receive an invoice when the cycle starts.")}
              </div>
              {/* Post-payment (upfront captain): assign/change the players covered by the payment. */}
              {group?.can_manage_group && token && (
                <Button onClick={() => setGroupMode('manage')} disabled={acting} className="w-full sm:w-auto">
                  {t('rebookGroup.manageEntry', 'Stel je groep samen →')}
                </Button>
              )}
            </div>
          ) : declined || status === 'declined' ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <XCircle className="h-5 w-5" /> {t('rebooking.released', 'Your spot has been released. Thanks for letting us know.')}
            </div>
          ) : windowEnded ? (
            <div>
              <p className="text-sm text-muted-foreground mb-2">{t('rebooking.windowEnded', 'The reservation period has ended.')}</p>
              <p className="text-sm text-muted-foreground mb-3">{t('rebooking.windowEndedRecovery', 'Your spot has been released to others. Still room? You can book again below. Questions? Contact the academy.')}</p>
              <Button asChild aria-label={t('rebooking.browse', 'Browse available spots')}><Link to={`/app/book/${data.slot.trainer_id}`}>{t('rebooking.browse', 'Browse available spots')}</Link></Button>
            </div>
          ) : (
            <div className="space-y-3 pt-2">
              <div className="flex flex-col sm:flex-row gap-2">
                <Button
                  onClick={onClaim}
                  disabled={acting}
                  variant={intent === 'decline' ? 'outline' : 'default'}
                  className="flex-1"
                >
                  {acting ? t('rebooking.working', 'Working…') : t('rebooking.keep', 'Yes, keep my spot')}
                </Button>
                <Button
                  onClick={onDecline}
                  disabled={acting}
                  variant={intent === 'decline' ? 'default' : 'outline'}
                  className="flex-1"
                >
                  {acting ? '…' : t('rebooking.release', 'No, release my spot')}
                </Button>
              </div>
              {/* Re-book the whole group. DEFERRED → open the roster editor now (each player is
                  billed their own share at cycle start). UPFRONT → pay-first: book only the
                  captain's seat + one group invoice + checkout, then assign the roster after
                  payment (manage mode) — so no guests/bookings are created before money lands. */}
              {group?.can_rebook_group && group.members.length > 1 && (
                <button
                  type="button"
                  onClick={paymentMode === 'upfront' ? onUpfrontGroupPay : () => setGroupMode('apply')}
                  disabled={acting}
                  className="inline-flex items-center gap-1 text-sm text-primary underline underline-offset-2"
                >
                  {paymentMode === 'upfront'
                    ? t('rebookGroup.entryUpfront', 'Boek en betaal in één keer voor de hele groep →')
                    : t('rebookGroup.entry', 'Boek je voor de anderen ook? Schrijf de hele groep opnieuw in →')}
                </button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
