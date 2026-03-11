import { useNavigate } from 'react-router-dom';
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

  if (type === 'request_sent') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="max-w-md w-full p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center mx-auto mb-4">
            <SendHorizontal className="h-8 w-8 text-blue-600" />
          </div>
          <h2 className="text-2xl font-bold mb-2">Request Sent!</h2>
          <p className="text-muted-foreground mb-6">
            Your booking request has been sent to {trainerName}.
            You'll be notified once they respond.
          </p>
          <div className="space-y-3">
            <Button className="w-full" onClick={() => navigate('/app/player/bookings')}>
              View My Bookings
            </Button>
            <Button variant="outline" className="w-full" onClick={() => navigate('/trainers')}>
              Browse Other Trainers
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
        <h2 className="text-2xl font-bold mb-2">Booking Confirmed!</h2>
        <p className="text-muted-foreground mb-6">
          Your lesson with {trainerName} has been booked.
          You'll receive a confirmation soon.
        </p>
        {useManualInvoicing && (
          <div className="p-3 bg-amber-50 dark:bg-amber-950 rounded-lg mb-4 flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
            <FileText className="h-4 w-4" />
            You'll receive an invoice from the trainer for payment.
          </div>
        )}
        <div className="space-y-3">
          <Button className="w-full" onClick={() => navigate('/app/player/bookings')}>
            View My Bookings
          </Button>
          <Button variant="outline" className="w-full" onClick={() => navigate('/trainers')}>
            Browse Other Trainers
          </Button>
        </div>
      </Card>
    </div>
  );
}
