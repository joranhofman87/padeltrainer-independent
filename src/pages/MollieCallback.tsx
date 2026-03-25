import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, CheckCircle, XCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { trackEvent } from '@/lib/tracking';
import { logger } from '@/lib/logger';

type CallbackStatus = 'processing' | 'success' | 'error';

export default function MollieCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<CallbackStatus>('processing');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [organizationName, setOrganizationName] = useState<string>('');

  useEffect(() => {
    const callbackStatus = searchParams.get('status');
    const name = searchParams.get('name');
    const message = searchParams.get('message');
    const entity = searchParams.get('entity');
    const code = searchParams.get('code');

    // If we have a status param, the backend already processed the callback
    if (callbackStatus === 'success') {
      setOrganizationName(name || '');
      setStatus('success');
      trackEvent('payment_connected', { role: entity || 'trainer' });

      // Redirect after short delay to show success message
      setTimeout(() => {
        if (entity === 'academy') {
          navigate('/academy/settings?mollie_connected=true');
        } else {
          navigate('/trainer/earnings?mollie_connected=true');
        }
      }, 2000);
      return;
    }

    if (callbackStatus === 'error') {
      setStatus('error');
      const msg = message || 'Something went wrong while connecting your Mollie account.';
      logger.error('Mollie connection failed', new Error(msg), { component: 'MollieCallback', entity: entity || 'unknown' });
      setErrorMessage(msg);
      return;
    }

    // If there's a code param but no status, Mollie redirected here directly
    // (shouldn't happen with the new architecture, but handle gracefully)
    if (code) {
      setStatus('error');
      setErrorMessage('The connection flow encountered an unexpected redirect. Please try again.');
      return;
    }

    // No recognized params - show error
    setStatus('error');
    setErrorMessage('Missing connection parameters. Please try again.');
  }, [searchParams, navigate]);

  const handleRetry = () => {
    const entity = searchParams.get('entity') || searchParams.get('state')?.split('_')[0];
    if (entity === 'academy') {
      navigate('/academy/settings');
    } else {
      navigate('/trainer/earnings');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardContent className="pt-6">
          {status === 'processing' && (
            <div className="text-center space-y-4">
              <Loader2 className="h-12 w-12 animate-spin mx-auto text-primary" />
              <h2 className="text-xl font-semibold">Connecting your Mollie account...</h2>
              <p className="text-muted-foreground">
                Please wait while we complete the connection.
              </p>
            </div>
          )}

          {status === 'success' && (
            <div className="text-center space-y-4">
              <CheckCircle className="h-12 w-12 mx-auto text-green-500" />
              <h2 className="text-xl font-semibold">Successfully connected!</h2>
              <p className="text-muted-foreground">
                {organizationName
                  ? `Your Mollie account "${organizationName}" has been connected.`
                  : 'Your Mollie account has been connected successfully.'}
              </p>
              <p className="text-sm text-muted-foreground">
                Redirecting you back...
              </p>
            </div>
          )}

          {status === 'error' && (
            <div className="text-center space-y-4">
              <XCircle className="h-12 w-12 mx-auto text-destructive" />
              <h2 className="text-xl font-semibold">Connection failed</h2>
              <p className="text-muted-foreground">
                {errorMessage}
              </p>
              <Button onClick={handleRetry} className="mt-4">
                Try again
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
