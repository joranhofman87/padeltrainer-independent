import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { signInWithEmail, signInWithGoogle } from '@/lib/auth';
import { useAuth } from '@/hooks/useAuth';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';

export default function Auth() {
  const [searchParams] = useSearchParams();
  const [isLoading, setIsLoading] = useState(false);
  const [isProcessingMagicLink, setIsProcessingMagicLink] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { toast } = useToast();
  const navigate = useNavigate();
  const { user, role, loading, refreshAuth } = useAuth();
  const { t } = useTranslation('auth');

  // Detect and handle magic link tokens in URL hash (for impersonation)
  useEffect(() => {
    const hashParams = new URLSearchParams(window.location.hash.substring(1));
    const accessToken = hashParams.get('access_token');
    const refreshToken = hashParams.get('refresh_token');
    const providerToken = hashParams.get('provider_token');
    
    // Only handle magic link tokens, NOT OAuth callbacks
    // OAuth callbacks include provider_token and are handled by Supabase automatically
    if (accessToken && refreshToken && !providerToken) {
      setIsProcessingMagicLink(true);
      // Explicitly set the session with tokens from URL hash - this overrides any existing session
      supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      }).then(({ error }) => {
        if (error) {
          console.error('Failed to set session from magic link:', error);
          toast({
            title: t('signIn.error', 'Login failed'),
            description: t('verification.linkExpired', 'The login link may have expired. Please try again.'),
            variant: 'destructive',
          });
        }
        // Clear the hash from URL for cleaner UX
        window.history.replaceState(null, '', window.location.pathname);
        setIsProcessingMagicLink(false);
      }).catch(() => {
        // Safety: ensure we never hang on magic link processing
        setIsProcessingMagicLink(false);
      });
    }
  }, [toast, t]);

  // Handle email confirmation redirect and errors
  useEffect(() => {
    const type = searchParams.get('type');
    const error = searchParams.get('error');
    const errorDescription = searchParams.get('error_description');
    
    if (error) {
      // Handle verification errors (e.g., expired/reused link)
      toast({
        title: t('verification.error', 'Verification Error'),
        description: errorDescription || t('verification.linkExpired', 'This verification link has expired or was already used.'),
        variant: 'destructive',
      });
    } else if (type === 'signup' || type === 'email_change') {
      toast({
        title: t('verification.confirmed'),
        description: t('verification.confirmedDescription'),
      });
    }
  }, [searchParams, toast, t]);

  const hasCheckedRoles = useRef(false);

  useEffect(() => {
    if (!loading && user) {
      const redirectUrl = sessionStorage.getItem('redirectAfterLogin');
      
      if (role) {
        // Existing user with role - clear any stale pendingRole and redirect
        localStorage.removeItem('pendingRole');
        
        if (redirectUrl) {
          sessionStorage.removeItem('redirectAfterLogin');
          navigate(redirectUrl);
        } else {
          if (role === 'admin') {
            navigate('/admin');
          } else if (role === 'trainer') {
            navigate('/trainer');
          } else if (role === 'club') {
            navigate('/club');
          } else {
            navigate('/player');
          }
        }
      } else if (!hasCheckedRoles.current) {
        // Role is null - check DB once to distinguish race condition from new user
        hasCheckedRoles.current = true;
        const checkExistingRoles = async () => {
          const { data } = await supabase
            .from('user_roles')
            .select('role')
            .eq('user_id', user.id)
            .limit(1);
          
          if (data && data.length > 0) {
            localStorage.removeItem('pendingRole');
            await refreshAuth();
          } else {
            if (redirectUrl) {
              sessionStorage.removeItem('redirectAfterLogin');
            }
            const pendingRole = localStorage.getItem('pendingRole');
            if (pendingRole) {
              localStorage.removeItem('pendingRole');
              navigate(`/onboarding/${pendingRole}`);
            } else {
              navigate('/onboarding/player');
            }
          }
        };
        checkExistingRoles();
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

  if (loading || isProcessingMagicLink) {
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
            data-testid="auth-google-button"
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
                data-testid="auth-email-input"
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
                data-testid="auth-password-input"
              />
            </div>
            <Button type="submit" className="w-full" disabled={isLoading} data-testid="auth-login-button">
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
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
