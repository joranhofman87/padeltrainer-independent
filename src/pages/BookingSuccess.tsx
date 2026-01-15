import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Check, Loader2, XCircle, Calendar, ArrowRight } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

export default function BookingSuccess() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();

  const [verifying, setVerifying] = useState(true);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionId = searchParams.get('session_id');
  const bookingId = searchParams.get('booking_id');

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (sessionId && bookingId && user) {
      verifyPayment();
    }
  }, [sessionId, bookingId, user]);

  const verifyPayment = async () => {
    try {
      const { data, error: fnError } = await supabase.functions.invoke('verify-payment', {
        body: { sessionId, bookingId },
      });

      if (fnError) throw fnError;

      if (data.paid) {
        setVerified(true);
        toast({
          title: 'Payment Successful',
          description: 'Your booking has been confirmed!',
        });
      } else {
        setError('Payment was not completed. Please try again.');
      }
    } catch (err: any) {
      console.error('Verification error:', err);
      setError(err.message || 'Failed to verify payment');
    } finally {
      setVerifying(false);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

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
                  Add to your calendar
                </li>
              </ul>
            </div>
          )}

          <div className="flex flex-col gap-3">
            <Button className="w-full" onClick={() => navigate('/bookings')}>
              <Calendar className="h-4 w-4 mr-2" />
              View My Bookings
            </Button>
            <Button variant="outline" className="w-full" onClick={() => navigate('/trainers')}>
              Book Another Lesson
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
