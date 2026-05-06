import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { CalendarClock, MapPin, CheckCircle2, XCircle } from 'lucide-react';
import { fetchClaimByToken, declineClaimWithToken } from '@/lib/priorityClaims';

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
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<ClaimData | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [declined, setDeclined] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetchClaimByToken(token)
      .then((res) => setData(res as unknown as ClaimData | null))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [token]);

  const onClaim = () => {
    if (!data || !token) return;
    navigate(`/app/book/${data.slot.trainer_id}?slot=${data.slot.id}&claim=${token}`);
  };

  const onDecline = async () => {
    if (!token) return;
    setActing(true);
    try {
      await declineClaimWithToken(token, 'Player declined via priority link');
      setDeclined(true);
      toast.success('Bedankt voor je reactie. Je plek is vrijgegeven.');
    } catch (e) {
      toast.error((e as Error).message);
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

  if (!data) {
    return (
      <div className="container max-w-xl mx-auto py-16 px-4 text-center">
        <Helmet><meta name="robots" content="noindex" /></Helmet>
        <h1 className="text-2xl font-bold mb-2">Link not found</h1>
        <p className="text-muted-foreground">This claim link is invalid or has expired.</p>
      </div>
    );
  }

  const windowEnded = data.slot.priority_window_ends_at && new Date(data.slot.priority_window_ends_at) < new Date();
  const status = data.claim.status;
  const start = new Date(data.slot.start_time);
  const end = new Date(data.slot.end_time);

  return (
    <div className="container max-w-xl mx-auto py-12 px-4">
      <Helmet><title>Reserve your spot</title><meta name="robots" content="noindex" /></Helmet>

      <Card>
        <CardHeader>
          <CardTitle>{data.slot.cyclus_name ?? 'Your priority spot'}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {data.player_name ? `Hi ${data.player_name},` : 'Hi,'} you have priority to claim your spot for the next cycle.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-3">
            <CalendarClock className="h-5 w-5 mt-0.5 text-muted-foreground" />
            <div>
              <div className="font-medium">{format(start, 'EEEE d MMMM yyyy')}</div>
              <div className="text-sm text-muted-foreground">{format(start, 'HH:mm')} - {format(end, 'HH:mm')}</div>
            </div>
          </div>
          {data.slot.price_per_session && (
            <div className="flex items-start gap-3">
              <MapPin className="h-5 w-5 mt-0.5 text-muted-foreground" />
              <div className="text-sm">EUR {Number(data.slot.price_per_session).toFixed(2)} per session</div>
            </div>
          )}
          {data.slot.priority_window_ends_at && !windowEnded && (
            <p className="text-sm text-muted-foreground">
              Please respond before {format(new Date(data.slot.priority_window_ends_at), 'd MMM yyyy HH:mm')}.
            </p>
          )}

          {declined || status === 'declined' ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <XCircle className="h-5 w-5" /> You released this spot. Thanks for letting us know.
            </div>
          ) : status === 'claimed' ? (
            <div className="flex items-center gap-2 text-green-600">
              <CheckCircle2 className="h-5 w-5" /> You already claimed this spot.
            </div>
          ) : windowEnded ? (
            <div>
              <p className="text-sm text-muted-foreground mb-3">The priority window has ended.</p>
              <Button asChild><Link to={`/app/book/${data.slot.trainer_id}`}>Browse public availability</Link></Button>
            </div>
          ) : (
            <div className="flex flex-col sm:flex-row gap-2 pt-2">
              <Button onClick={onClaim} className="flex-1">Yes, claim my spot</Button>
              <Button onClick={onDecline} variant="outline" disabled={acting} className="flex-1">
                {acting ? 'Releasing...' : "No, I won't continue"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
