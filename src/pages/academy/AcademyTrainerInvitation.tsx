import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle, XCircle, Loader2, GraduationCap, AlertCircle, Percent } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { getAcademyInvitationByToken, respondToAcademyTrainerInvitation } from '@/lib/academy';
import { sendEmail } from '@/lib/email';

export default function AcademyTrainerInvitation() {
  const { t } = useTranslation('academy');
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, role, loading: authLoading } = useAuth();

  const [invitation, setInvitation] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchInvitation() {
      if (!token) {
        setError('Invalid invitation link');
        setLoading(false);
        return;
      }

      const data = await getAcademyInvitationByToken(token);
      if (!data) {
        setError('This invitation was not found or has expired');
      } else {
        setInvitation(data);
      }
      setLoading(false);
    }

    fetchInvitation();
  }, [token]);

  const handleResponse = async (accept: boolean) => {
    if (!user || !token) return;

    setResponding(true);
    try {
      const result = await respondToAcademyTrainerInvitation(token, accept, user.id);

      if (!result.success) {
        toast({
          title: 'Error',
          description: result.error,
          variant: 'destructive',
        });
        return;
      }

      if (accept) {
        // Send acceptance notification to academy manager
        const { data: inviterProfile } = await import('@/integrations/supabase/client').then(
          (mod) =>
            mod.supabase
              .from('profiles')
              .select('email, full_name')
              .eq('user_id', invitation.invited_by)
              .single()
        );

        const { data: trainerProfile } = await import('@/integrations/supabase/client').then(
          (mod) =>
            mod.supabase
              .from('profiles')
              .select('full_name, email')
              .eq('user_id', user.id)
              .single()
        );

        if (inviterProfile?.email) {
          await sendEmail('academy_trainer_invitation_accepted', inviterProfile.email, {
            academyName: invitation.academy_profiles?.name,
            trainerName: trainerProfile?.full_name || 'A trainer',
            trainerEmail: trainerProfile?.email,
            ownerName: inviterProfile.full_name,
          });
        }

        toast({
          title: t('trainerInvitation.acceptedTitle'),
          description: t('trainerInvitation.acceptedDescription'),
        });
      } else {
        toast({
          title: t('trainerInvitation.declinedTitle'),
          description: t('trainerInvitation.declinedDescription'),
        });
      }

      // Redirect to trainer dashboard
      navigate('/trainer');
    } catch (error) {
      console.error('Error responding to invitation:', error);
      toast({
        title: 'Error',
        description: 'Failed to respond to invitation',
        variant: 'destructive',
      });
    } finally {
      setResponding(false);
    }
  };

  if (loading || authLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <Skeleton className="h-8 w-48 mb-2" />
            <Skeleton className="h-4 w-64" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-24" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-6 w-6" />
              {t('trainerInvitation.invalidTitle')}
            </CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => navigate('/')} className="w-full">
              {t('common:goHome')}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (invitation.status !== 'pending') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>
              {invitation.status === 'accepted'
                ? t('trainerInvitation.alreadyAcceptedTitle')
                : invitation.status === 'declined'
                ? t('trainerInvitation.alreadyDeclinedTitle')
                : t('trainerInvitation.expiredTitle')}
            </CardTitle>
            <CardDescription>
              {t('trainerInvitation.alreadyRespondedDescription')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => navigate('/')} className="w-full">
              {t('common:goHome')}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Not logged in
  if (!user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-primary">{t('trainerInvitation.title')}</CardTitle>
            <CardDescription>
              {t('trainerInvitation.loginRequired')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-muted p-4 rounded-lg">
              <div className="flex items-center gap-3 mb-3">
                {invitation.academy_profiles?.logo_url ? (
                  <img
                    src={invitation.academy_profiles.logo_url}
                    alt={invitation.academy_profiles.name}
                    className="h-12 w-12 rounded-lg object-cover"
                  />
                ) : (
                  <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center">
                    <GraduationCap className="h-6 w-6 text-primary" />
                  </div>
                )}
                <div>
                  <h3 className="font-semibold text-lg">{invitation.academy_profiles?.name}</h3>
                  <p className="text-sm text-muted-foreground">
                    {t('trainerInvitation.invitedBy')}: {invitation.inviter_name}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Percent className="h-4 w-4" />
                <span>
                  {invitation.payment_percentage}% {t('trainerInvitation.trainerShare')}
                </span>
              </div>
              {invitation.message && (
                <p className="text-sm mt-2 italic text-muted-foreground">"{invitation.message}"</p>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <Button asChild>
                <Link to={`/auth?redirect=/academy/invitation/${token}`}>
                  {t('common:signIn')}
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link to={`/signup/trainer?redirect=/academy/invitation/${token}`}>
                  {t('common:signUp')}
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Not a trainer
  if (role !== 'trainer') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-6 w-6" />
              {t('trainerInvitation.trainerRequiredTitle')}
            </CardTitle>
            <CardDescription>
              {t('trainerInvitation.trainerRequiredDescription')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-muted p-4 rounded-lg">
              <h3 className="font-semibold">{invitation.academy_profiles?.name}</h3>
              <p className="text-sm text-muted-foreground">
                {t('trainerInvitation.invitedBy')}: {invitation.inviter_name}
              </p>
            </div>
            <Button asChild className="w-full">
              <Link to="/signup/trainer">{t('trainerInvitation.becomeTrainer')}</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Valid invitation, logged in as trainer
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-primary">{t('trainerInvitation.title')}</CardTitle>
          <CardDescription>{t('trainerInvitation.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="bg-muted p-4 rounded-lg">
            <div className="flex items-center gap-3 mb-3">
              {invitation.academy_profiles?.logo_url ? (
                <img
                  src={invitation.academy_profiles.logo_url}
                  alt={invitation.academy_profiles.name}
                  className="h-12 w-12 rounded-lg object-cover"
                />
              ) : (
                <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center">
                  <GraduationCap className="h-6 w-6 text-primary" />
                </div>
              )}
              <div>
                <h3 className="font-semibold text-lg">{invitation.academy_profiles?.name}</h3>
              </div>
            </div>
            <p className="text-sm">
              <span className="text-muted-foreground">{t('trainerInvitation.invitedBy')}:</span>{' '}
              {invitation.inviter_name}
            </p>
            <div className="flex items-center gap-2 text-sm mt-2 font-medium">
              <Percent className="h-4 w-4" />
              <span>
                {invitation.payment_percentage}% {t('trainerInvitation.trainerShare')}
              </span>
            </div>
            {invitation.message && (
              <div className="mt-3 p-3 bg-background rounded border">
                <p className="text-sm italic">"{invitation.message}"</p>
              </div>
            )}
          </div>

          <div className="space-y-3">
            <h4 className="font-medium">{t('trainerInvitation.benefitsTitle')}</h4>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li>• {t('trainerInvitation.benefit1')}</li>
              <li>• {t('trainerInvitation.benefit2')}</li>
              <li>• {t('trainerInvitation.benefit3')}</li>
            </ul>
          </div>

          <div className="flex gap-3">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => handleResponse(false)}
              disabled={responding}
            >
              {responding ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <XCircle className="h-4 w-4 mr-2" />
              )}
              {t('trainerInvitation.decline')}
            </Button>
            <Button className="flex-1" onClick={() => handleResponse(true)} disabled={responding}>
              {responding ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <CheckCircle className="h-4 w-4 mr-2" />
              )}
              {t('trainerInvitation.accept')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
