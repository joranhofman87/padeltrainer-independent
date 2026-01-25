import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { setUserRole, UserRole } from '@/lib/auth';
import { useAuth } from '@/hooks/useAuth';
import { useEffect } from 'react';
import { Users, GraduationCap, Check } from 'lucide-react';

export default function SelectRole() {
  const { t } = useTranslation('common');
  const [selectedRole, setSelectedRole] = useState<UserRole | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();
  const { user, role, loading, refreshAuth } = useAuth();

  useEffect(() => {
    if (!loading) {
      // If user signed up as club, redirect to club onboarding
      const storedPendingRole = sessionStorage.getItem('pendingRole');
      if (storedPendingRole === 'club') {
        navigate('/onboarding/club');
        return;
      }
      
      if (!user) {
        navigate('/auth');
      } else if (role) {
        // Priority: admin > trainer > player
        if (role === 'admin') {
          navigate('/admin');
        } else if (role === 'trainer') {
          navigate('/trainer');
        } else {
          navigate('/player');
        }
      }
    }
  }, [user, role, loading, navigate]);

  const handleConfirmRole = async () => {
    if (!selectedRole || !user) return;

    setIsLoading(true);
    try {
      await setUserRole(user.id, selectedRole);
      await refreshAuth();
      toast({
        title: t('roles.selected'),
        description: t('roles.registeredAs', { role: t(`roles.${selectedRole}`) }),
      });
      navigate(selectedRole === 'trainer' ? '/trainer' : '/player');
    } catch (error: any) {
      toast({
        title: t('toasts.errorTitle'),
        description: error.message || 'Failed to set role',
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/10 via-background to-secondary/10 p-4">
      <div className="w-full max-w-2xl space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl sm:text-3xl font-bold">Welcome to PadelTrainer<span className="text-primary">.ai</span></h1>
          <p className="text-muted-foreground">
            Choose how you want to use the platform
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <Card
            className={`cursor-pointer transition-all hover:shadow-lg ${
              selectedRole === 'player'
                ? 'ring-2 ring-primary border-primary'
                : 'hover:border-primary/50'
            }`}
            onClick={() => setSelectedRole('player')}
          >
            <CardHeader className="text-center pb-2">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900">
                <Users className="h-7 w-7 text-blue-600 dark:text-blue-400" />
              </div>
              <CardTitle className="flex items-center justify-center gap-2">
                Player
                {selectedRole === 'player' && (
                  <Check className="h-5 w-5 text-primary" />
                )}
              </CardTitle>
              <CardDescription>Find and book training sessions</CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <span className="text-green-500">✓</span>
                  Browse all available trainers
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-green-500">✓</span>
                  Book lessons matching your skill level
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-green-500">✓</span>
                  Track your training progress
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-green-500">✓</span>
                  Connect your KNLTB rating
                </li>
              </ul>
            </CardContent>
          </Card>

          <Card
            className={`cursor-pointer transition-all hover:shadow-lg ${
              selectedRole === 'trainer'
                ? 'ring-2 ring-primary border-primary'
                : 'hover:border-primary/50'
            }`}
            onClick={() => setSelectedRole('trainer')}
          >
            <CardHeader className="text-center pb-2">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-orange-100 dark:bg-orange-900">
                <GraduationCap className="h-7 w-7 text-orange-600 dark:text-orange-400" />
              </div>
              <CardTitle className="flex items-center justify-center gap-2">
                Trainer
                {selectedRole === 'trainer' && (
                  <Check className="h-5 w-5 text-primary" />
                )}
              </CardTitle>
              <CardDescription>Offer training and grow your business</CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <span className="text-green-500">✓</span>
                  Create your public trainer profile
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-green-500">✓</span>
                  Set up lessons and availability
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-green-500">✓</span>
                  Receive payments through the platform
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-green-500">✓</span>
                  Manage private groups & academies
                </li>
              </ul>
            </CardContent>
          </Card>
        </div>

        <div className="text-center">
          <Button
            size="lg"
            className="min-w-[200px]"
            disabled={!selectedRole || isLoading}
            onClick={handleConfirmRole}
          >
            {isLoading ? 'Setting up...' : `Continue as ${selectedRole || '...'}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
