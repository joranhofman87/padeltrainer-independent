import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { signInWithEmail, signInWithGoogle } from '@/lib/auth';
import { useAuth } from '@/hooks/useAuth';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';

export default function Auth() {
  const [isLoading, setIsLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { toast } = useToast();
  const navigate = useNavigate();
  const { user, role, loading } = useAuth();
  const { t } = useTranslation('auth');

  useEffect(() => {
    if (!loading && user) {
      if (role) {
        // Priority: admin > trainer > club > player
        if (role === 'admin') {
          navigate('/admin');
        } else if (role === 'trainer') {
          navigate('/trainer');
        } else if (role === 'club') {
          navigate('/club');
        } else {
          navigate('/player');
        }
      } else {
        // User without role - check for pending role from signup
        const pendingRole = sessionStorage.getItem('pendingRole');
        if (pendingRole) {
          navigate(`/onboarding/${pendingRole}`);
        } else {
          // Fallback to select-role for edge cases
          navigate('/select-role');
        }
      }
    }
  }, [user, role, loading, navigate]);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    const { error } = await signInWithEmail(email, password);

    if (error) {
      toast({
        title: t('signIn.error', 'Error'),
        description: error.message,
        variant: 'destructive',
      });
    }

    setIsLoading(false);
  };

  const handleGoogleSignIn = async () => {
    setIsLoading(true);
    const { error } = await signInWithGoogle();

    if (error) {
      toast({
        title: t('signIn.error', 'Error'),
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
          <div className="mb-4">
            <span className="font-bold text-2xl">PadelTrainer<span className="text-primary">.ai</span></span>
          </div>
          <CardDescription>
            {t('subtitle')}
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

          <form onSubmit={handleSignIn} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="signin-email">{t('form.email')}</Label>
              <Input
                id="signin-email"
                type="email"
                placeholder={t('form.emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="signin-password">{t('form.password')}</Label>
                <Link 
                  to="/forgot-password" 
                  className="text-sm text-primary hover:underline"
                >
                  {t('signIn.forgotPassword', 'Forgot password?')}
                </Link>
              </div>
              <Input
                id="signin-password"
                type="password"
                placeholder={t('form.passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? t('signIn.loading') : t('signIn.button')}
            </Button>
          </form>

          <div className="space-y-3 pt-4 border-t">
            <p className="text-center text-sm text-muted-foreground">
              {t('signIn.noAccount', "Don't have an account?")}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Button variant="outline" asChild>
                <Link to="/signup/player">{t('signIn.signupPlayer', 'Join as Player')}</Link>
              </Button>
              <Button variant="outline" asChild>
                <Link to="/signup/trainer">{t('signIn.signupTrainer', 'Join as Trainer')}</Link>
              </Button>
            </div>
            <p className="text-center text-sm text-muted-foreground pt-2">
              {t('signIn.clubOwner', 'Are you a club owner?')}{' '}
              <Link to="/signup/club" className="text-primary hover:underline font-medium">
                {t('signIn.registerClub', 'Register your club')}
              </Link>
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
