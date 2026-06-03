import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { signUpWithEmail, signInWithGoogle } from '@/lib/auth';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { PasswordStrengthIndicator } from '@/components/ui/password-strength';
import { VerificationPending } from '@/components/auth/VerificationPending';
import { PasswordInput } from '@/components/auth/PasswordInput';
import { SignupNameFields } from '@/components/auth/SignupNameFields';
import { TrainerSignupLayout } from '@/components/auth/TrainerSignupLayout';
import { createSignupSchema } from '@/lib/signupSchema';
import { useHoneypot } from '@/hooks/useHoneypot';
import { logger } from '@/lib/logger';
import { FeatureErrorBoundary } from '@/components/FeatureErrorBoundary';
import { trackEvent } from '@/lib/tracking';
import { getUtmParams } from '@/lib/utm';

export default function ClubSignup() {
  const [isLoading, setIsLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [errors, setErrors] = useState<{ [key: string]: string }>({});
  const [showVerification, setShowVerification] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();
  const { user, role, loading } = useAuth();
  const { t, i18n } = useTranslation('auth');
  const { honeypotRef, isSuspicious } = useHoneypot();

  useEffect(() => {
    if (!loading && user) {
      if (role) {
        // User already has a role - check if they're a club manager
        navigate('/app/onboarding/club');
      } else {
        // New user - redirect to club onboarding
        navigate('/app/onboarding/club');
      }
    }
  }, [user, role, loading, navigate]);

  const validateForm = () => {
    try {
      createSignupSchema(t).parse({ firstName, lastName, email, password });
      setErrors({});
      return true;
    } catch (error) {
      if (error instanceof z.ZodError) {
        const newErrors: { [key: string]: string } = {};
        error.errors.forEach((err) => {
          if (err.path[0]) {
            newErrors[err.path[0] as string] = err.message;
          }
        });
        setErrors(newErrors);
      }
      return false;
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateForm()) return;
    if (isSuspicious()) return;
    
    try { trackEvent('signup_started', { role: 'club', method: 'email', ...getUtmParams() }); } catch {}
    setIsLoading(true);

    try {
      const { data, error } = await signUpWithEmail(email, password, firstName, lastName, undefined, undefined, 'club');

      if (error) {
        logger.error('Club signup failed', error, { component: 'ClubSignup', action: 'signUp' });
        toast({
          title: t('signUp.error', 'Error'),
          description: error.message,
          variant: 'destructive',
        });
      } else if (data?.session) {
        try { trackEvent('signup_completed', { role: 'club', method: 'email' }); } catch {}
        localStorage.setItem('pendingRole', 'club');
        if (data.user?.id) {
          supabase.from('profiles').update({ preferred_language: i18n.language } as any).eq('user_id', data.user.id).then(() => {});
        }
        toast({
          title: t('signUp.success'),
          description: t('signUp.successDescription'),
        });
        navigate('/app/onboarding/club');
      } else {
        try { trackEvent('signup_completed', { role: 'club', method: 'email' }); } catch {}
        localStorage.setItem('pendingRole', 'club');
        setShowVerification(true);
      }
    } catch (err) {
      logger.error('Unexpected signup error', err as Error, { component: 'ClubSignup' });
      toast({
        title: t('signUp.error', 'Error'),
        description: t('signIn.genericError', 'Something went wrong. Please try again.'),
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setIsLoading(true);
    try {
      try { trackEvent('signup_started', { role: 'club', method: 'google', ...getUtmParams() }); } catch {}
      localStorage.setItem('pendingRole', 'club');
      
      const { error } = await signInWithGoogle();

      if (error) {
        toast({
          title: t('signUp.error', 'Error'),
          description: error.message,
          variant: 'destructive',
        });
      }
    } catch (err) {
      logger.error('Unexpected Google signup error', err as Error, { component: 'ClubSignup' });
    } finally {
      setIsLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (showVerification) {
    return (
      <VerificationPending 
        email={email} 
        onBack={() => setShowVerification(false)} 
      />
    );
  }

  return (
    <FeatureErrorBoundary featureName="ClubSignup" onRetry={() => window.location.reload()}>
    <TrainerSignupLayout activeRole="club" pageTestId="page-signup-club">
      <Card className="w-full shadow-sm" data-testid="form-signup-club">
        <CardHeader className="space-y-1 pb-4">
          <CardTitle className="text-xl font-semibold">{t('clubSignup.cardTitle')}</CardTitle>
          <CardDescription>{t('clubSignup.cardSubtitle')}</CardDescription>
          <p className="text-xs text-muted-foreground pt-1">{t('clubSignup.trustLine')}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button
            variant="outline"
            className="w-full h-12 text-base"
            onClick={handleGoogleSignIn}
            disabled={isLoading}
          >
            <svg className="mr-2 h-5 w-5" viewBox="0 0 24 24">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            {t('social.google')}
          </Button>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">{t('social.orEmail', 'or with email')}</span>
            </div>
          </div>

          <form onSubmit={handleSignUp} className="space-y-4">
            {/* Honeypot field - hidden from humans */}
            <div style={{ position: 'absolute', left: '-9999px' }} aria-hidden="true">
              <input type="text" name="website" tabIndex={-1} autoComplete="off" ref={honeypotRef} />
            </div>
            <SignupNameFields
              firstName={firstName}
              lastName={lastName}
              onFirstNameChange={setFirstName}
              onLastNameChange={setLastName}
              errors={{
                firstName: errors.firstName,
                lastName: errors.lastName,
              }}
            />
            <div className="space-y-2">
              <Label htmlFor="signup-email">{t('form.email')}</Label>
              <Input
                id="signup-email"
                type="email"
                placeholder={t('form.emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={errors.email ? 'border-destructive' : ''}
                required
                data-testid="input-signup-email"
              />
              {errors.email && (
                <p className="text-sm text-destructive">{errors.email}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="signup-password">{t('form.password')}</Label>
              <PasswordInput
                id="signup-password"
                name="password"
                placeholder={t('form.passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={errors.password ? 'border-destructive' : ''}
                aria-invalid={!!errors.password}
                required
                minLength={8}
                disabled={isLoading}
                data-testid="input-signup-password"
              />
              <PasswordStrengthIndicator password={password} />
              {errors.password && (
                <p className="text-sm text-destructive">{errors.password}</p>
              )}
            </div>
            <Button type="submit" className="w-full h-11" disabled={isLoading} data-testid="btn-signup-submit">
              {isLoading ? t('signUp.loading') : t('signUp.button')}
            </Button>
          </form>

          <p className="text-center text-sm text-muted-foreground">
            {t('clubSignup.alreadyHaveAccount', 'Already have an account?')}{' '}
            <Link to="/app/auth" className="font-medium text-primary hover:underline">
              {t('signIn.button')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </TrainerSignupLayout>
    </FeatureErrorBoundary>
  );
}
