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
  getUnpaidRebookInvoiceByToken,
  recordRebookRulesConsent,
  recordPriorityClaimIntent,
  type RebookPaymentMode,
  type RebookGroup,
  type RebookGroupApplyResult,
} from '@/lib/priorityClaims';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { isBlankRichTextHtml } from '@/lib/richText';
import { formatCurrency, formatDate } from '@/lib/format';
import { QueryErrorState } from '@/components/ui/QueryErrorState';
import { RebookGroupEditor } from '@/components/cycles/RebookGroupEditor';
import { RichTextConsent } from '@/components/ui/rich-text-consent';

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
  // The cycle's rebooking-rules HTML (from the SECURITY DEFINER claim RPC), else null.
  rebook_rules: string | null;
  // Payment mode from the token RPC — status-independent, so it stays correct even after the
  // cycle leaves 'open' (unlike the cycles_public read). Absent pre-migration → fall back.
  rebook_payment_mode?: string | null;
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
  // Per-round rebooking rules + the player's opt-in. When rules exist, the proceed buttons are
  // gated until the player ticks the consent box (declining is never gated).
  const [rebookRules, setRebookRules] = useState<string | null>(null);
  const [rulesAccepted, setRulesAccepted] = useState(false);
  const [group, setGroup] = useState<RebookGroup | null>(null);
  // null = claim card; 'apply' = deferred group editor; 'manage' = post-payment roster editor.
  const [groupMode, setGroupMode] = useState<'apply' | 'manage' | null>(null);
  // Resume-payment: the pay token of an accepted-but-UNPAID upfront rebook invoice (checkout dropped /
  // page refreshed). When set, the claimed state shows "Continue to payment" instead of deferred copy.
  const [unpaidInvoiceToken, setUnpaidInvoiceToken] = useState<string | null>(null);

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
        // The rules ride along in the SECURITY DEFINER claim payload (RLS-bypassed), so the consent
        // gate can't silently fail open the way a separate, status-gated cycles read could. Blank
        // editor HTML normalizes to null → no rules, no gate.
        const rawRules = claim?.rebook_rules ?? null;
        setRebookRules(isBlankRichTextHtml(rawRules) ? null : rawRules);
        // Mode-aware copy + "starts on" date + the group roster (for the "re-book the
        // whole group" option): read in parallel; each falls back gracefully. Prefer the
        // status-independent mode the token RPC now returns; only hit the cycles_public read
        // when it's absent (frontend deployed before the migration).
        const rpcMode = claim?.rebook_payment_mode;
        const modePromise: Promise<RebookPaymentMode> =
          rpcMode === 'upfront' || rpcMode === 'deferred_split'
            ? Promise.resolve(rpcMode)
            : getCycleRebookPaymentMode(claim?.slot?.cyclus_id);
        const [mode, startDate, grp] = await Promise.all([
          modePromise,
          getCycleStartDate(claim?.slot?.cyclus_id),
          fetchRebookGroupByToken(token).catch(() => null),
        ]);
        setPaymentMode(mode);
        setCycleStartDate(startDate);
        setGroup(grp);
        // Resume-payment: an already-accepted UPFRONT claim may have an unpaid invoice (Mollie was
        // dropped / the page was refreshed). Look up its pay token so the claimed state can offer
        // "Continue to payment" instead of the deferred "you'll get an invoice" dead-end. Key off the
        // locally-resolved `mode` + claim status (not the async state, which hasn't committed yet).
        // Best-effort + fail-open (no token → keeps today's copy).
        if (mode === 'upfront' && claim?.claim?.status === 'claimed') {
          const inv = await getUnpaidRebookInvoiceByToken(token);
          setUnpaidInvoiceToken(inv?.public_token ?? null);
        } else {
          setUnpaidInvoiceToken(null);
        }
      })
      .catch(() => setLoadFailed(true))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    loadClaim();
  }, [loadClaim]);

  // Store WHICH button they clicked, the moment they land from an email button — even if they
  // never finish checkout. Best-effort; only stamps a still-pending claim, never changes status.
  useEffect(() => {
    if (token && data && (intent === 'accept' || intent === 'decline')) {
      void recordPriorityClaimIntent(token, intent);
    }
  }, [token, data, intent]);

  const onClaim = async () => {
    if (!token) return;
    setActing(true);
    try {
      // Record the Yes click before we leave for payment (captures an on-page press + a later
      // abandoned checkout). Best-effort, never blocks.
      void recordPriorityClaimIntent(token, 'accept');
      // Record consent BEFORE accepting — a successful accept redirects to Mollie, so nothing after
      // it runs. Best-effort: never blocks the flow (the checkbox already enforced the agreement).
      if (rebookRules) await recordRebookRulesConsent(token);
      const res = await acceptClaimAndStartPayment(token);
      if (res?.ok) {
        // RB-P2-05: some sessions were full at accept time — tell the player instead of a silent
        // partial booking. (On a redirect branch the pay page also shows the actual set booked.)
        if ((res.skippedFull ?? 0) > 0) {
          toast.warning(t('rebooking.someSessionsFull', '{{n}} sessie(s) waren vol en zijn niet geboekt.', { n: res.skippedFull }));
        }
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
        if (res.mode === 'already_paid') {
          // Re-click / stale tab on an already-PAID rebook: success — never an error.
          toast.success(t('rebooking.alreadyPaid', 'This spot is already paid — you’re all set.'));
          setAccepted(true);
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
      // Record the captain's consent before the group checkout redirect (best-effort).
      if (rebookRules) await recordRebookRulesConsent(token);
      const res = await createGroupRebookInvoice(token);
      // Already PAID (another member / a stale tab): success — refresh so the page shows the
      // paid-group state. Checked BEFORE the publicToken branch (a paid response carries it too).
      if (res.ok && (res.alreadyPaid || res.status === 'paid')) {
        toast.success(t('rebookGroup.alreadyPaidInfo', 'Your group is already paid — nothing left to do.'));
        loadClaim();
        return;
      }
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
      if (res.reason === 'member_already_paid') {
        // I1 cross-guard: a teammate already paid for just their own seat — the full-court group
        // payment would double-collect it. The academy sorts this out (they were alerted).
        toast.error(t('rebookGroup.memberAlreadyPaid', 'Someone in your group already paid for their own spot. Contact the academy to arrange the group payment.'));
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
  // A claim the cron expired or a manager released is no longer actionable even if its window
  // isn't (yet) past — without this it would fall through to live Yes/No buttons that the
  // server then refuses with a confusing "already responded".
  const claimClosed = status !== 'pending' && status !== 'claimed' && status !== 'declined';
  const start = new Date(data.slot.start_time);
  const end = new Date(data.slot.end_time);
  // The player can still keep/release → show the "how it works" explainer.
  const actionable = !accepted && !declined && status === 'pending' && !windowEnded;
  // When the round has rules, proceeding (keep / group re-book) requires the opt-in tick. Declining never does.
  const rulesBlocked = !!rebookRules && !rulesAccepted;

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
          {data.slot.price_per_session ? (
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
          ) : data.slot.total_price ? (
            /* Court-priced slot (per-session null): total_price is already the whole-term total. */
            <div className="flex items-start gap-3">
              <MapPin className="h-5 w-5 mt-0.5 text-muted-foreground" />
              <div className="text-sm font-medium text-foreground">
                {t('rebooking.termTotalFlat', '{{total}} for the full term', {
                  total: formatCurrency(Number(data.slot.total_price)),
                })}
              </div>
            </div>
          ) : null}
          {(data.slot.price_per_session || data.slot.total_price) && (
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
              {paymentMode === 'upfront' && unpaidInvoiceToken ? (
                // Accepted an UPFRONT rebook but payment isn't finished (dropped checkout / refresh):
                // offer to resume instead of the deferred "you'll get an invoice" copy — on a strict
                // cycle no invoice is ever sent, so this is the only way to complete the booking.
                <>
                  <div className="flex items-center gap-2 text-amber-600">
                    <CalendarClock className="h-5 w-5" />
                    {t('rebooking.upfrontReserved', 'Your spot is reserved — complete payment to confirm it.')}
                  </div>
                  <Button asChild disabled={acting} className="w-full sm:w-auto" aria-label={t('rebooking.continuePayment', 'Continue to payment →')}>
                    <Link to={`/pay/${unpaidInvoiceToken}`}>{t('rebooking.continuePayment', 'Continue to payment →')}</Link>
                  </Button>
                </>
              ) : (
                <>
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
                </>
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
          ) : claimClosed ? (
            <div>
              <p className="text-sm text-muted-foreground mb-2">{t('rebooking.claimClosed', 'This invitation is no longer active.')}</p>
              <p className="text-sm text-muted-foreground mb-3">{t('rebooking.claimClosedRecovery', 'Your priority spot has been released. Still room? You can book again below. Questions? Contact the academy.')}</p>
              <Button asChild aria-label={t('rebooking.browse', 'Browse available spots')}><Link to={`/app/book/${data.slot.trainer_id}`}>{t('rebooking.browse', 'Browse available spots')}</Link></Button>
            </div>
          ) : group?.group_invoice_status === 'paid' ? (
            // AUDIT FIX: the group's court is already PAID (captain's invoice) — a pending teammate
            // must see that, not the pay buttons ("pay for the whole group" would hit the paid
            // invoice; "just my own spot" would stack a second charge — both server-refused now,
            // but the UI should never steer them there). Declining stays possible: it frees their
            // seat so the captain can assign someone else.
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-green-600">
                <CheckCircle2 className="h-5 w-5" />
                {(() => {
                  const captain = group.members?.find((m) => m.status === 'claimed' && !m.is_self)?.first_name;
                  return captain
                    ? t('rebookGroup.groupPaidBy', '{{name}} has already paid for your group — your spot is covered once the line-up is confirmed.', { name: captain })
                    : t('rebookGroup.groupPaid', 'Your group is already paid — your spot is covered once the line-up is confirmed.');
                })()}
              </div>
              <Button onClick={onDecline} disabled={acting} variant="outline" className="w-full sm:w-auto">
                {acting ? '…' : t('rebooking.release', 'No, release my spot')}
              </Button>
            </div>
          ) : (
            <div className="space-y-3 pt-2">
              {rebookRules && (
                <RichTextConsent
                  variant="accordion"
                  content={rebookRules}
                  accepted={rulesAccepted}
                  onAcceptChange={setRulesAccepted}
                  title={t('rebooking.rulesConsentTitle', 'Rebooking rules')}
                  checkboxLabel={t('rebooking.rulesConsentLabel', 'I agree to the rebooking rules')}
                />
              )}
              {/* Whole-group rebook is the PRIMARY action: one player rebooks + (upfront) pays for
                  the whole group at full price and edits the roster (keep/remove/add people). DEFERRED
                  → open the roster editor now (each player billed their share at cycle start). UPFRONT
                  → pay-first (book only the captain's seat + one full-price group invoice + checkout),
                  then assign the roster after payment. "Just my own spot" stays as a secondary option. */}
              {group?.can_rebook_group && group.members.length > 1 ? (
                <>
                  <Button
                    onClick={paymentMode === 'upfront'
                      ? onUpfrontGroupPay
                      : () => { if (token && rebookRules) void recordRebookRulesConsent(token); setGroupMode('apply'); }}
                    disabled={acting || rulesBlocked}
                    className="w-full"
                  >
                    {acting
                      ? t('rebooking.working', 'Working…')
                      : paymentMode === 'upfront'
                        ? t('rebookGroup.primaryUpfront', 'Ja — boek en betaal voor de hele groep')
                        : t('rebookGroup.primary', 'Ja — schrijf de hele groep opnieuw in')}
                  </Button>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Button onClick={onClaim} disabled={acting || rulesBlocked} variant="outline" className="flex-1">
                      {t('rebooking.keepJustMe', 'Alleen mijn eigen plek')}
                    </Button>
                    <Button onClick={onDecline} disabled={acting} variant="outline" className="flex-1">
                      {acting ? '…' : t('rebooking.release', 'No, release my spot')}
                    </Button>
                  </div>
                </>
              ) : (
                <div className="flex flex-col sm:flex-row gap-2">
                  <Button
                    onClick={onClaim}
                    disabled={acting || rulesBlocked}
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
              )}
              {rulesBlocked && (
                <p className="text-xs text-muted-foreground">
                  {t('rebooking.consentRequiredHint', 'Agree to the rebooking rules above to continue.')}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
