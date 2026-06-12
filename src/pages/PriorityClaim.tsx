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
  declineClaimWithToken,
  acceptClaimAndStartPayment,
  getCycleRebookPaymentMode,
  type RebookPaymentMode,
} from '@/lib/priorityClaims';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { formatCurrency, formatDate } from '@/lib/format';
import { QueryErrorState } from '@/components/ui/QueryErrorState';

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
  player_name: string | null;
  player_email: string | null;
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

  const loadClaim = useCallback(() => {
    if (!token) return;
    setLoading(true);
    setLoadFailed(false);
    fetchClaimByToken(token)
      // A null result is a definitive "no such claim"; a throw is a failed
      // request (network/5xx) — the link may still be valid, so offer a retry.
      .then(async (res) => {
        const claim = res as unknown as ClaimData | null;
        setData(claim);
        // Mode-aware copy: read the cycle's rebook payment mode (cycles with
        // status 'open' are publicly readable; falls back to deferred).
        setPaymentMode(await getCycleRebookPaymentMode(claim?.slot?.cyclus_id));
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
          {data.slot.price_per_session && (
            <div className="flex items-start gap-3">
              <MapPin className="h-5 w-5 mt-0.5 text-muted-foreground" />
              <div className="text-sm">
                {t('rebooking.perSession', '{{amount}} per session', { amount: formatCurrency(Number(data.slot.price_per_session)) })}
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
          {data.slot.priority_window_ends_at && !windowEnded && (
            <p className="text-sm text-muted-foreground">
              {t('rebooking.respondBefore', 'Respond before {{date}}.', { date: formatDate(data.slot.priority_window_ends_at, 'd MMM yyyy HH:mm') })}
            </p>
          )}

          {accepted || status === 'claimed' ? (
            <div className="flex items-center gap-2 text-green-600">
              <CheckCircle2 className="h-5 w-5" /> {t('rebooking.reserved', "Your spot is reserved. You'll receive an invoice when the cycle starts.")}
            </div>
          ) : declined || status === 'declined' ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <XCircle className="h-5 w-5" /> {t('rebooking.released', 'Your spot has been released. Thanks for letting us know.')}
            </div>
          ) : windowEnded ? (
            <div>
              <p className="text-sm text-muted-foreground mb-3">{t('rebooking.windowEnded', 'The reservation period has ended.')}</p>
              <Button asChild aria-label={t('rebooking.browse', 'Browse available spots')}><Link to={`/app/book/${data.slot.trainer_id}`}>{t('rebooking.browse', 'Browse available spots')}</Link></Button>
            </div>
          ) : (
            <div className="flex flex-col sm:flex-row gap-2 pt-2">
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
          )}
        </CardContent>
      </Card>
    </div>
  );
}
