import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { XCircle, ArrowLeft, Calendar } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';

export default function BookingCancelled() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [trainerSlug, setTrainerSlug] = useState<string | null>(null);

  const bookingId = searchParams.get('booking_id');

  useEffect(() => {
    if (!bookingId) return;

    const fetchTrainer = async () => {
      try {
        const { data } = await supabase
          .from('bookings')
          .select('availability_slots(trainer_id)')
          .eq('id', bookingId)
          .maybeSingle();

        const slot = (data as any)?.availability_slots;
        if (slot?.trainer_id) {
          const { data: trainer } = await supabase
            .from('trainer_profiles')
            .select('slug')
            .eq('id', slot.trainer_id)
            .maybeSingle();
          if (trainer?.slug) setTrainerSlug(trainer.slug);
        }
      } catch (err) {
        logger.warn('Could not fetch trainer for cancelled booking', { bookingId });
      }
    };

    fetchTrainer();
  }, [bookingId]);

  const tryAgainPath = trainerSlug ? `/nl/book/${trainerSlug}` : '/app/player/bookings';

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10 p-4">
      <Card className="max-w-md w-full">
        <CardHeader className="text-center">
          <div className="w-16 h-16 rounded-full bg-orange-100 dark:bg-orange-900 flex items-center justify-center mx-auto mb-4">
            <XCircle className="h-8 w-8 text-orange-600" />
          </div>
          <CardTitle className="text-orange-600">Betaling niet voltooid</CardTitle>
          <CardDescription>
            De betaling is geannuleerd of niet afgerond. Er is geen bedrag afgeschreven.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3">
            <Button className="w-full" onClick={() => navigate(tryAgainPath)}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Opnieuw proberen
            </Button>
            <Button variant="outline" className="w-full" onClick={() => navigate('/app/player/bookings')}>
              <Calendar className="h-4 w-4 mr-2" />
              Mijn boekingen bekijken
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
