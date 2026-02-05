import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, CheckCircle, XCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type CallbackStatus = 'processing' | 'success' | 'error';

export default function MollieCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<CallbackStatus>('processing');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [organizationName, setOrganizationName] = useState<string>('');

  useEffect(() => {
    const handleCallback = async () => {
      const code = searchParams.get('code');
      const state = searchParams.get('state');
      const oauthError = searchParams.get('error');
      const errorDescription = searchParams.get('error_description');

      // Handle OAuth error from Mollie
      if (oauthError) {
        setStatus('error');
        setErrorMessage(errorDescription || oauthError);
        return;
      }

      if (!code || !state) {
        setStatus('error');
        setErrorMessage('Missing authorization code or state parameter');
        return;
      }

      try {
        // Call the edge function to exchange the code for tokens
        const { data, error } = await supabase.functions.invoke('mollie-callback', {
          body: { code, state, error: oauthError, error_description: errorDescription },
        });

        if (error) {
          throw new Error(error.message || 'Failed to complete Mollie connection');
        }

        if (data?.error) {
          throw new Error(data.error);
        }

        setOrganizationName(data.organizationName || '');
        setStatus('success');

        // Parse state to determine redirect path
        // Format: "trainer_{trainerId}_{randomState}" or "academy_{academyId}_{randomState}"
        const entityType = state.split('_')[0];

        // Redirect after short delay to show success message
        setTimeout(() => {
          if (entityType === 'academy') {
            navigate('/academy/earnings?mollie_connected=true');
          } else {
            navigate('/trainer/earnings?mollie_connected=true');
          }
        }, 2000);
      } catch (err) {
        setStatus('error');
        setErrorMessage(err instanceof Error ? err.message : 'An unexpected error occurred');
      }
    };

    handleCallback();
  }, [searchParams, navigate]);

  const handleRetry = () => {
    // Parse state to determine where to redirect for retry
    const state = searchParams.get('state');
    const entityType = state?.split('_')[0];
    
    if (entityType === 'academy') {
      navigate('/academy/earnings');
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
                {errorMessage || 'Something went wrong while connecting your Mollie account.'}
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
