import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from 'react-i18next';
import { Mail, ArrowLeft, RefreshCw } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';

interface VerificationPendingProps {
  email: string;
  onBack?: () => void;
}

export function VerificationPending({ email, onBack }: VerificationPendingProps) {
  const [isResending, setIsResending] = useState(false);
  const { toast } = useToast();
  const { t } = useTranslation('auth');

  const handleResend = async () => {
    setIsResending(true);
    
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email,
    });

    if (error) {
      toast({
        title: t('verification.error', 'Error'),
        description: error.message,
        variant: 'destructive',
      });
    } else {
      toast({
        title: t('verification.resent'),
        description: t('verification.resentDescription'),
      });
    }

    setIsResending(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/10 via-background to-secondary/10 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          {onBack && (
            <button
              onClick={onBack}
              className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-primary mb-4 self-start"
            >
              <ArrowLeft className="h-4 w-4" />
              {t('backToHome', 'Back')}
            </button>
          )}
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <Mail className="h-8 w-8 text-primary" />
          </div>
          <CardTitle className="text-2xl font-bold">{t('verification.pending')}</CardTitle>
          <CardDescription className="mt-2">
            {t('verification.pendingDescription', { email })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg bg-muted/50 p-4 text-sm text-muted-foreground text-center">
            {t('verification.checkSpam')}
          </div>

          <Button
            variant="outline"
            className="w-full"
            onClick={handleResend}
            disabled={isResending}
          >
            {isResending ? (
              <>
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                {t('verification.resending')}
              </>
            ) : (
              <>
                <RefreshCw className="mr-2 h-4 w-4" />
                {t('verification.resend')}
              </>
            )}
          </Button>

          <p className="text-center text-sm text-muted-foreground">
            {t('verification.alreadyVerified', 'Already verified?')}{' '}
            <Link to="/auth" className="text-primary hover:underline">
              {t('signIn.button')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
