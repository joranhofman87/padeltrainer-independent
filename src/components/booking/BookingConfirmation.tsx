import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Check, SendHorizontal, FileText } from 'lucide-react';

interface BookingConfirmationProps {
  type: 'request_sent' | 'booked';
  trainerName: string;
  useManualInvoicing?: boolean;
}

export function BookingConfirmation({ type, trainerName, useManualInvoicing }: BookingConfirmationProps) {
  const navigate = useNavigate();
  const { t } = useTranslation('player');

  if (type === 'request_sent') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="max-w-md w-full p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center mx-auto mb-4">
            <SendHorizontal className="h-8 w-8 text-blue-600" />
          </div>
          <h2 className="text-2xl font-bold mb-2">{t('bookingConfirmation.requestSentTitle')}</h2>
          <p className="text-muted-foreground mb-6">
            {t('bookingConfirmation.requestSentBody', { trainer: trainerName })}
          </p>
          <div className="space-y-3">
            <Button className="w-full" onClick={() => navigate('/app/player/bookings')}>
              {t('bookingConfirmation.viewMyBookings')}
            </Button>
            <Button variant="outline" className="w-full" onClick={() => navigate('/trainers')}>
              {t('bookingConfirmation.browseOtherTrainers')}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="max-w-md w-full p-8 text-center">
        <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900 flex items-center justify-center mx-auto mb-4">
          <Check className="h-8 w-8 text-green-600" />
        </div>
        <h2 className="text-2xl font-bold mb-2">{t('bookingConfirmation.bookedTitle')}</h2>
        <p className="text-muted-foreground mb-6">
          {t('bookingConfirmation.bookedBody', { trainer: trainerName })}
        </p>
        {useManualInvoicing && (
          <div className="p-3 bg-amber-50 dark:bg-amber-950 rounded-lg mb-4 flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
            <FileText className="h-4 w-4" />
            {t('bookingConfirmation.invoiceNotice')}
          </div>
        )}
        <div className="space-y-3">
          <Button className="w-full" onClick={() => navigate('/app/player/bookings')}>
            {t('bookingConfirmation.viewMyBookings')}
          </Button>
          <Button variant="outline" className="w-full" onClick={() => navigate('/trainers')}>
            {t('bookingConfirmation.browseOtherTrainers')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
