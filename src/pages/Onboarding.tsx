import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { setUserRole, updateProfile, UserRole } from '@/lib/auth';
import { useAuth } from '@/hooks/useAuth';
import { useTranslation } from 'react-i18next';
import { Phone, User, CheckCircle2 } from 'lucide-react';

export default function Onboarding() {
  const { role: urlRole } = useParams<{ role: string }>();
  const [isLoading, setIsLoading] = useState(false);
  const [phone, setPhone] = useState('');
  const [knltbNumber, setKnltbNumber] = useState('');
  const { toast } = useToast();
  const navigate = useNavigate();
  const { user, role, loading, refreshAuth } = useAuth();
  const { t } = useTranslation('auth');

  // Determine the role from URL or sessionStorage
  const pendingRole = (urlRole === 'player' || urlRole === 'trainer') 
    ? urlRole 
    : (sessionStorage.getItem('pendingRole') as UserRole | null);

  useEffect(() => {
    if (!loading) {
      if (!user) {
        // Not logged in - redirect to appropriate signup
        navigate(pendingRole === 'trainer' ? '/signup/trainer' : '/signup/player');
      } else if (role) {
        // Already has a role - redirect to dashboard
        navigate(role === 'trainer' ? '/trainer' : '/player');
      }
    }
  }, [user, role, loading, navigate, pendingRole]);

  const handleComplete = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!phone.trim()) {
      toast({
        title: t('onboarding.error', 'Error'),
        description: t('onboarding.phoneRequired', 'Phone number is required'),
        variant: 'destructive',
      });
      return;
    }

    if (!user || !pendingRole) return;

    setIsLoading(true);
    try {
      // Update profile with phone and optionally KNLTB number
      const profileUpdates: { phone: string; knltb_number?: string } = { phone };
      if (pendingRole === 'player' && knltbNumber.trim()) {
        profileUpdates.knltb_number = knltbNumber.trim();
      }
      
      await updateProfile(user.id, profileUpdates);
      
      // Set the user role
      await setUserRole(user.id, pendingRole);
      
      // Clear session storage
      sessionStorage.removeItem('pendingRole');
      
      await refreshAuth();
      
      toast({
        title: t('onboarding.success', 'Welcome!'),
        description: t('onboarding.successDescription', 'Your account is ready.'),
      });
      
      navigate(pendingRole === 'trainer' ? '/trainer' : '/player');
    } catch (error: any) {
      toast({
        title: t('onboarding.error', 'Error'),
        description: error.message || 'Failed to complete setup',
        variant: 'destructive',
      });
    }
    setIsLoading(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  const isPlayer = pendingRole === 'player';

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/10 via-background to-secondary/10 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <User className="h-8 w-8 text-primary" />
          </div>
          <CardTitle className="text-2xl font-bold">
            {t('onboarding.title', 'Complete Your Profile')}
          </CardTitle>
          <CardDescription>
            {t('onboarding.subtitle', "Just a few more details and you're ready to go")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleComplete} className="space-y-6">
            {/* Phone Number */}
            <div className="space-y-2">
              <Label htmlFor="phone" className="flex items-center gap-2">
                <Phone className="h-4 w-4" />
                {t('onboarding.phoneLabel', 'Phone Number')}
              </Label>
              <Input
                id="phone"
                type="tel"
                placeholder="+31 6 12345678"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
              />
              <p className="text-xs text-muted-foreground">
                {t('onboarding.phoneDescription', "We'll send you updates about cancelled lessons, new availability from trainers you follow, and important booking reminders.")}
              </p>
            </div>

            {/* KNLTB Number - Only for players */}
            {isPlayer && (
              <div className="space-y-2">
                <Label htmlFor="knltb" className="flex items-center gap-2">
                  <span className="text-sm">🎾</span>
                  {t('onboarding.knltbLabel', 'KNLTB Number')}
                  <span className="text-xs text-muted-foreground">({t('onboarding.optional', 'optional')})</span>
                </Label>
                <Input
                  id="knltb"
                  type="text"
                  placeholder="12345678"
                  value={knltbNumber}
                  onChange={(e) => setKnltbNumber(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t('onboarding.knltbDescription', "We'll automatically track your official rating and show your progress over time.")}
                </p>
              </div>
            )}

            {/* Benefits reminder */}
            <div className="bg-accent/50 rounded-lg p-4 space-y-2">
              <p className="text-sm font-medium">{t('onboarding.whatYouGet', "What you'll get")}:</p>
              <ul className="text-sm text-muted-foreground space-y-1">
                {isPlayer ? (
                  <>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-primary" />
                      {t('onboarding.playerBenefit1', 'Notifications for new trainer availability')}
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-primary" />
                      {t('onboarding.playerBenefit2', 'Booking confirmations & reminders')}
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-primary" />
                      {t('onboarding.playerBenefit3', 'Automatic KNLTB rating tracking')}
                    </li>
                  </>
                ) : (
                  <>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-primary" />
                      {t('onboarding.trainerBenefit1', 'New booking notifications')}
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-primary" />
                      {t('onboarding.trainerBenefit2', 'Player cancellation alerts')}
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-primary" />
                      {t('onboarding.trainerBenefit3', 'Payment confirmations')}
                    </li>
                  </>
                )}
              </ul>
            </div>

            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? t('onboarding.completing', 'Setting up...') : t('onboarding.complete', 'Complete Setup')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
