import { useState, useEffect } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { signUpWithEmail, signInWithGoogle } from '@/lib/auth';
import { useAuth } from '@/hooks/useAuth';
import { useTranslation } from 'react-i18next';
import { GraduationCap, ArrowLeft } from 'lucide-react';
import { z } from 'zod';
import { PasswordStrengthIndicator } from '@/components/ui/password-strength';
import { VerificationPending } from '@/components/auth/VerificationPending';

const signupSchema = z.object({
  fullName: z.string().trim().min(2, 'Name must be at least 2 characters'),
  email: z.string().trim().email('Please enter a valid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

export default function TrainerSignup() {
  const [isLoading, setIsLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [errors, setErrors] = useState<{ [key: string]: string }>({});
  const [showVerification, setShowVerification] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, role, loading } = useAuth();
  const { t } = useTranslation('auth');

  useEffect(() => {
    if (!loading && user) {
      if (role) {
        navigate(role === 'trainer' ? '/trainer' : '/player');
      } else {
        // New user - redirect to complete onboarding
        navigate('/onboarding/trainer');
      }
    }
  }, [user, role, loading, navigate]);

  const validateForm = () => {
    try {
      signupSchema.parse({ fullName, email, password });
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
    
    setIsLoading(true);

    const { data, error } = await signUpWithEmail(email, password, fullName);

    if (error) {
      toast({
        title: t('signUp.error', 'Error'),
        description: error.message,
        variant: 'destructive',
      });
    } else if (data?.session) {
      // Session is immediately available (auto-confirm enabled for dev)
      localStorage.setItem('pendingRole', 'trainer');
      // Store redirect URL if present
      const redirectUrl = searchParams.get('redirect');
      if (redirectUrl) {
        localStorage.setItem('redirectAfterOnboarding', redirectUrl);
      }
      toast({
        title: t('signUp.success'),
        description: t('signUp.successDescription'),
      });
      navigate('/onboarding/trainer');
    } else {
      // No immediate session - email verification required
      localStorage.setItem('pendingRole', 'trainer');
      // Store redirect URL if present
      const redirectUrl = searchParams.get('redirect');
      if (redirectUrl) {
        localStorage.setItem('redirectAfterOnboarding', redirectUrl);
      }
      setShowVerification(true);
    }

    setIsLoading(false);
  };

  const handleGoogleSignIn = async () => {
    setIsLoading(true);
    // Store role preference before OAuth redirect
    localStorage.setItem('pendingRole', 'trainer');
    // Store redirect URL if present
    const redirectUrl = searchParams.get('redirect');
    if (redirectUrl) {
      localStorage.setItem('redirectAfterOnboarding', redirectUrl);
    }
    
    const { error } = await signInWithGoogle();

    if (error) {
      toast({
        title: t('signUp.error', 'Error'),
        description: error.message,
        variant: 'destructive',
      });
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
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/10 via-background to-secondary/10 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <Link 
            to="/" 
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-primary mb-4 self-start"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('backToHome', 'Back to home')}
          </Link>
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-orange-100 dark:bg-orange-900">
            <GraduationCap className="h-8 w-8 text-orange-600 dark:text-orange-400" />
          </div>
          <CardTitle className="text-2xl font-bold">{t('trainerSignup.title', 'Join as a Trainer')}</CardTitle>
          <CardDescription>
            {t('trainerSignup.subtitle', 'Grow your business and connect with players')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Google OAuth - Prominent */}
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
            <div className="space-y-2">
              <Label htmlFor="signup-name">{t('form.fullName')}</Label>
              <Input
                id="signup-name"
                type="text"
                placeholder={t('form.fullNamePlaceholder')}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className={errors.fullName ? 'border-destructive' : ''}
                required
              />
              {errors.fullName && (
                <p className="text-sm text-destructive">{errors.fullName}</p>
              )}
            </div>
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
              />
              {errors.email && (
                <p className="text-sm text-destructive">{errors.email}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="signup-password">{t('form.password')}</Label>
              <Input
                id="signup-password"
                type="password"
                placeholder={t('form.passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={errors.password ? 'border-destructive' : ''}
                required
                minLength={6}
              />
              <PasswordStrengthIndicator password={password} />
              {errors.password && (
                <p className="text-sm text-destructive">{errors.password}</p>
              )}
            </div>
            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? t('signUp.loading') : t('signUp.button')}
            </Button>
          </form>

          <p className="text-center text-sm text-muted-foreground">
            {t('trainerSignup.alreadyHaveAccount', 'Already have an account?')}{' '}
            <Link to="/auth" className="text-primary hover:underline">
              {t('signIn.button')}
            </Link>
          </p>
          
          <p className="text-center text-sm text-muted-foreground">
            {t('trainerSignup.wantToPlay', 'Looking for a trainer instead?')}{' '}
            <Link to="/signup/player" className="text-primary hover:underline">
              {t('trainerSignup.joinAsPlayer', 'Join as Player')}
            </Link>
          </p>
          
          <p className="text-center text-sm text-muted-foreground">
            {t('signIn.clubOwner', 'Are you a club owner?')}{' '}
            <Link to="/signup/club" className="text-primary hover:underline font-medium">
              {t('signIn.registerClub', 'Register your club')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
