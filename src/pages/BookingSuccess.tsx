import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Check, Loader2, XCircle, Calendar, ArrowRight } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { useToast } from '@/hooks/use-toast';
import { logger } from '@/lib/logger';
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } from '@/components/LanguageRouter';

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 15;

interface BookingDetails {
  startTime: string;
  endTime: string;
  trainerName: string;
  trainerSlug: string;
}

function toGoogleCalendarDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function buildGoogleCalendarUrl(details: BookingDetails): string {
  const text = `Padel Lesson with ${details.trainerName}`;
  const dates = `${toGoogleCalendarDate(details.startTime)}/${toGoogleCalendarDate(details.endTime)}`;
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text,
    dates,
    details: `Padel lesson booked via PadelTrainer`,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export default function BookingSuccess() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { lang } = useParams<{ lang: string }>();
  const currentLang = lang && SUPPORTED_LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE;

  const [verifying, setVerifying] = useState(true);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bookingDetails, setBookingDetails] = useState<BookingDetails | null>(null);
  const pollRef = useRef(0);

  const bookingId = searchParams.get('booking_id');

  useEffect(() => {
    if (!bookingId) {
      setError('No booking ID provided.');
      setVerifying(false);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const checkDatabase = async (): Promise<boolean> => {
      const { data, error: dbError } = await supabase
        .from('bookings')
        .select('payment_status, availability_slots(start_time, end_time, trainer_id)')
        .eq('id', bookingId)
        .maybeSingle();

      if (dbError) {
        logger.warn('DB poll error', { component: 'BookingSuccess', bookingId, error: dbError.message });
        return false;
      }

      if (data?.payment_status === 'paid') {
        // Fetch trainer details once we know it's paid
        const slot = (data as any).availability_slots;
        if (slot?.trainer_id) {
          const { data: trainer } = await supabase
            .from('trainer_profiles')
            .select('slug, user_id')
            .eq('id', slot.trainer_id)
            .maybeSingle();

          let trainerName = 'Trainer';
          if (trainer?.user_id) {
            const { data: profile } = await supabase
              .from('profiles')
              .select('full_name')
              .eq('user_id', trainer.user_id)
              .maybeSingle();
            if (profile?.full_name) trainerName = profile.full_name;
          }

          setBookingDetails({
            startTime: slot.start_time,
            endTime: slot.end_time,
            trainerName,
            trainerSlug: trainer?.slug || '',
          });
        }
        return true;
      }

      return false;
    };

    const callVerifyFallback = async (): Promise<boolean> => {
      try {
        const { data, error: fnError } = await supabase.functions.invoke('verify-mollie-payment', {
          body: { bookingId },
        });
        if (fnError) throw fnError;
        return !!data?.paid;
      } catch (err: any) {
        logger.error('verify-mollie-payment fallback failed', err, { component: 'BookingSuccess', bookingId });
        return false;
      }
    };

    const poll = async () => {
      if (cancelled) return;

      const isPaid = await checkDatabase();

      if (isPaid) {
        setVerified(true);
        setVerifying(false);
        toast({ title: 'Payment Successful', description: 'Your booking has been confirmed!' });
        return;
      }

      pollRef.current += 1;

      if (pollRef.current < MAX_POLL_ATTEMPTS) {
        timer = setTimeout(poll, POLL_INTERVAL_MS);
        return;
      }

      logger.info('DB polling exhausted, calling verify fallback', { component: 'BookingSuccess', bookingId });
      const fallbackPaid = await callVerifyFallback();

      if (cancelled) return;

      if (fallbackPaid) {
        setVerified(true);
        // Re-fetch details after fallback confirms paid
        await checkDatabase();
        toast({ title: 'Payment Successful', description: 'Your booking has been confirmed!' });
      } else {
        setError('Payment was not completed. Please try again or contact support.');
      }
      setVerifying(false);
    };

    poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [bookingId]);

  const bookAgainPath = bookingDetails?.trainerSlug
    ? `/${currentLang}/book/${bookingDetails.trainerSlug}`
    : '/app/trainers';

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-background to-blue-100/30 dark:from-blue-950/20 dark:via-background dark:to-blue-900/10 p-4">
      <Card className="max-w-md w-full">
        <CardHeader className="text-center">
          {verifying ? (
            <>
              <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
              <CardTitle>Verifying Payment</CardTitle>
              <CardDescription>Please wait while we confirm your payment...</CardDescription>
            </>
          ) : verified ? (
            <>
              <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900 flex items-center justify-center mx-auto mb-4">
                <Check className="h-8 w-8 text-green-600" />
              </div>
              <CardTitle className="text-green-600">Payment Successful!</CardTitle>
              <CardDescription>Your booking has been confirmed</CardDescription>
            </>
          ) : (
            <>
              <div className="w-16 h-16 rounded-full bg-red-100 dark:bg-red-900 flex items-center justify-center mx-auto mb-4">
                <XCircle className="h-8 w-8 text-red-600" />
              </div>
              <CardTitle className="text-red-600">Payment Issue</CardTitle>
              <CardDescription>{error || 'Something went wrong'}</CardDescription>
            </>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {verified && (
            <div className="bg-muted p-4 rounded-lg text-center">
              <p className="text-sm text-muted-foreground mb-2">What's next?</p>
              <ul className="text-sm space-y-2">
                <li className="flex items-center gap-2 justify-center">
                  <Check className="h-4 w-4 text-green-600" />
                  Confirmation email sent
                </li>
                <li className="flex items-center gap-2 justify-center">
                  <Calendar className="h-4 w-4 text-primary" />
                  {bookingDetails ? (
                    <a
                      href={buildGoogleCalendarUrl(bookingDetails)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-primary transition-colors"
                    >
                      Add to your calendar
                    </a>
                  ) : (
                    'Add to your calendar'
                  )}
                </li>
              </ul>
            </div>
          )}

          <div className="flex flex-col gap-3">
            <Button className="w-full" onClick={() => navigate('/app/player/bookings')}>
              <Calendar className="h-4 w-4 mr-2" />
              View My Bookings
            </Button>
            <Button variant="outline" className="w-full" onClick={() => navigate(bookAgainPath)}>
              Book Another Lesson
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
