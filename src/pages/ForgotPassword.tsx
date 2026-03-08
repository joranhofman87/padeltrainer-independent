import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { sendPasswordResetEmail } from '@/lib/auth';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Mail, CheckCircle } from 'lucide-react';
import { logger } from '@/lib/logger';

export default function ForgotPassword() {
  const [isLoading, setIsLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  const { toast } = useToast();
  const { t } = useTranslation('auth');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    const { error } = await sendPasswordResetEmail(email);

    if (error) {
      logger.error('Password reset email failed', error, { component: 'ForgotPassword' });
      toast({
        title: t('signIn.error', 'Error'),
        description: error.message,
        variant: 'destructive',
      });
      setIsLoading(false);
      return;
    }

    setEmailSent(true);
    setIsLoading(false);
  };

  if (emailSent) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/10 via-background to-secondary/10 p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <CheckCircle className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="text-2xl font-bold">
              {t('forgotPassword.success', 'Check your email')}
            </CardTitle>
            <CardDescription>
              {t('forgotPassword.successDescription', "We've sent you a password reset link.")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link to="/app/auth">
                <ArrowLeft className="mr-2 h-4 w-4" />
                {t('forgotPassword.backToLogin', 'Back to login')}
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/10 via-background to-secondary/10 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <Link 
            to="/app/auth" 
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-primary mb-4 self-start"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('forgotPassword.backToLogin', 'Back to login')}
          </Link>
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Mail className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-2xl font-bold">
            {t('forgotPassword.title', 'Reset Password')}
          </CardTitle>
          <CardDescription>
            {t('forgotPassword.subtitle', "Enter your email and we'll send you a reset link")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">{t('form.email', 'Email')}</Label>
              <Input
                id="email"
                type="email"
                placeholder={t('form.emailPlaceholder', 'your@email.com')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading 
                ? t('forgotPassword.loading', 'Sending...') 
                : t('forgotPassword.button', 'Send Reset Link')
              }
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
