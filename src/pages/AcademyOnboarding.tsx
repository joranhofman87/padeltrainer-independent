import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { useTranslation } from 'react-i18next';
import { GraduationCap } from 'lucide-react';
import { createAcademy } from '@/lib/academy';
import { supabase } from '@/integrations/supabase/client';

export default function AcademyOnboarding() {
  const [isLoading, setIsLoading] = useState(false);
  const [academyName, setAcademyName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [description, setDescription] = useState('');
  const { toast } = useToast();
  const navigate = useNavigate();
  const { user, profile, loading } = useAuth();
  const { t } = useTranslation('academy');

  useEffect(() => {
    if (!loading && !user) {
      navigate('/signup/academy');
    }
  }, [user, loading, navigate]);

  // Assign academy role immediately when user lands on the page
  useEffect(() => {
    const assignAcademyRole = async () => {
      if (user && localStorage.getItem('pendingRole') === 'academy') {
        try {
          const { error } = await supabase
            .from('user_roles')
            .insert({ user_id: user.id, role: 'academy' });
          
          // Clear pending role if successful or if it's a duplicate
          if (!error || error.code === '23505') {
            localStorage.removeItem('pendingRole');
          }
        } catch (err) {
          console.error('Error assigning academy role:', err);
        }
      }
    };
    assignAcademyRole();
  }, [user]);

  useEffect(() => {
    // Pre-fill contact email from user profile
    if (profile?.email) {
      setContactEmail(profile.email);
    } else if (user?.email) {
      setContactEmail(user.email);
    }
  }, [profile, user]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!academyName.trim()) {
      toast({
        title: t('onboarding.error', 'Error'),
        description: t('onboarding.nameRequired', 'Please enter your academy name'),
        variant: 'destructive',
      });
      return;
    }

    if (!contactEmail) {
      toast({
        title: t('onboarding.error', 'Error'),
        description: t('onboarding.emailRequired', 'Contact email is required'),
        variant: 'destructive',
      });
      return;
    }

    // Verify session is ready
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      toast({
        title: t('onboarding.error', 'Error'),
        description: t('onboarding.sessionExpired', 'Your session has expired. Please refresh and try again.'),
        variant: 'destructive',
      });
      return;
    }

    setIsLoading(true);

    try {
      const { success, error } = await createAcademy(
        academyName.trim(),
        session.user.id,
        contactEmail,
        description
      );
      
      if (error || !success) {
        throw error || new Error('Failed to create academy');
      }
      
      // Clear the pending role
      localStorage.removeItem('pendingRole');
      
      toast({
        title: t('onboarding.success', 'Academy Created!'),
        description: t('onboarding.successDescription', 'Your academy is pending verification. We will review it shortly.'),
      });
      
      navigate('/academy');
    } catch (error: any) {
      console.error('Academy creation error:', error);
      toast({
        title: t('onboarding.error', 'Error'),
        description: error.message || t('onboarding.errorDescription', 'Failed to create academy'),
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
      <Card className="w-full max-w-lg">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-purple-100 dark:bg-purple-900">
            <GraduationCap className="h-8 w-8 text-purple-600 dark:text-purple-400" />
          </div>
          <CardTitle className="text-2xl font-bold">
            {t('onboarding.title', 'Create Your Academy')}
          </CardTitle>
          <CardDescription>
            {t('onboarding.subtitle', 'Set up your padel training academy')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Academy Name */}
            <div className="space-y-2">
              <Label htmlFor="academy-name">
                {t('onboarding.academyName', 'Academy Name')} *
              </Label>
              <Input
                id="academy-name"
                type="text"
                value={academyName}
                onChange={(e) => setAcademyName(e.target.value)}
                placeholder={t('onboarding.namePlaceholder', 'Padel Pro Academy')}
                required
              />
            </div>

            {/* Contact Email */}
            <div className="space-y-2">
              <Label htmlFor="contact-email">
                {t('onboarding.contactEmail', 'Contact Email')} *
              </Label>
              <Input
                id="contact-email"
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                placeholder={t('onboarding.emailPlaceholder', 'info@youracademy.com')}
                required
              />
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="description">
                {t('onboarding.description', 'About Your Academy')}
              </Label>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('onboarding.descriptionPlaceholder', 'Tell us about your academy, your teaching philosophy, and what makes you unique...')}
                rows={4}
              />
            </div>

            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? t('onboarding.creating', 'Creating...') : t('onboarding.createAcademy', 'Create Academy')}
            </Button>

            <div className="rounded-lg bg-muted/50 p-4 text-center">
              <p className="text-sm text-muted-foreground">
                {t('onboarding.verificationNote', 'Your academy will be reviewed and verified by our team. You can start configuring your profile while waiting for verification.')}
              </p>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
