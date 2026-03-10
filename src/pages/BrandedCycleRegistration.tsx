import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { trackEvent } from '@/lib/tracking';
import WelcomeMessageCard from '@/components/shared/WelcomeMessageCard';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { Calendar, Clock, AlertCircle, MapPin, Building2 } from 'lucide-react';
import CycleApplicationForm from '@/components/cycles/CycleApplicationForm';
import CycleDetailDisplay from '@/components/cycles/CycleDetailDisplay';
import { ProfileLayout } from '@/components/profiles/ProfileLayout';
import { getCycle, hasPlayerApplied, type Cycle } from '@/lib/cycles';
import { getActiveLocations, type Location } from '@/lib/locations';
import { logger } from '@/lib/logger';
import FeatureErrorBoundary from '@/components/FeatureErrorBoundary';

interface OwnerBranding {
  name: string;
  slug: string;
  logo_url?: string | null;
  banner_url?: string | null;
  welcome_message?: string | null;
}

interface BrandedCycleRegistrationProps {
  ownerType: 'academy' | 'club';
}

export default function BrandedCycleRegistration({ ownerType }: BrandedCycleRegistrationProps) {
  const { slug, cycleId } = useParams<{ slug: string; cycleId: string }>();
  const { t, i18n } = useTranslation(['cycles', 'common']);
  const { user, profile, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const dateLocale = i18n.language === 'nl' ? nl : enUS;

  const [cycle, setCycle] = useState<Cycle | null>(null);
  const [owner, setOwner] = useState<OwnerBranding | null>(null);
  const [cycleLocation, setCycleLocation] = useState<{ name: string; city: string } | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [trainers, setTrainers] = useState<{ id: string; name: string }[]>([]);
  const [hasApplied, setHasApplied] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSuccess, setIsSuccess] = useState(false);

  useEffect(() => {
    if (cycleId) {
      trackEvent('branded_cycle_registration_viewed', { cycle_id: cycleId, owner_type: ownerType, slug });
    }
  }, [cycleId, ownerType, slug]);

  useEffect(() => {
    const fetchData = async () => {
      if (!cycleId || !slug) return;
      setIsLoading(true);

      try {
        // Fetch owner branding
        if (ownerType === 'academy') {
          const { data: academy } = await supabase
            .from('academy_profiles')
            .select('id, name, slug, logo_url, banner_url, welcome_message')
            .eq('slug', slug)
            .maybeSingle();
          if (academy) setOwner(academy);
        } else {
          // Club: fetch via location join
          const { data: club } = await supabase
            .from('club_profiles')
            .select('id, logo_url, banner_url, welcome_message, location_id')
            .eq('id', slug) // clubs use id in URL for now
            .maybeSingle();
          if (club) {
            const { data: loc } = await supabase
              .from('locations')
              .select('name')
              .eq('id', club.location_id)
              .maybeSingle();
            setOwner({
              name: loc?.name || 'Club',
              slug: slug!,
              logo_url: club.logo_url,
              banner_url: club.banner_url,
              welcome_message: club.welcome_message,
            });
          }
        }

        // Fetch cycle
        const cycleData = await getCycle(cycleId);
        if (!cycleData) { setCycle(null); return; }
        setCycle(cycleData);

        // Fetch cycle location
        if (cycleData.location_id) {
          const { data: locData } = await supabase
            .from('locations')
            .select('name, city')
            .eq('id', cycleData.location_id)
            .maybeSingle();
          if (locData) setCycleLocation(locData);
        }

        // Fetch trainers for the owner
        if (ownerType === 'academy') {
          const { data: academyTrainers } = await supabase
            .from('academy_trainers')
            .select('trainer_profile_id')
            .eq('academy_profile_id', cycleData.owner_id)
            .eq('status', 'active');

          if (academyTrainers && academyTrainers.length > 0) {
            const trainerIds = academyTrainers.map(at => at.trainer_profile_id);
            const { data: trainerProfiles } = await supabase
              .from('trainer_profiles')
              .select('id, user_id')
              .in('id', trainerIds);

            if (trainerProfiles) {
              const userIds = trainerProfiles.map(tp => tp.user_id);
              const { data: profiles } = await supabase
                .from('profiles')
                .select('user_id, full_name')
                .in('user_id', userIds);

              if (profiles) {
                setTrainers(trainerProfiles.map(tp => {
                  const prof = profiles.find(p => p.user_id === tp.user_id);
                  return { id: tp.id, name: prof?.full_name || 'Trainer' };
                }));
              }
            }
          }
        }

        // Fetch locations
        const locationsData = await getActiveLocations();
        setLocations(locationsData);

        // Check if user has already applied
        if (user) {
          const { data: playerProfile } = await supabase
            .from('profiles')
            .select('id')
            .eq('user_id', user.id)
            .maybeSingle();

          if (playerProfile) {
            const applied = await hasPlayerApplied(cycleId, playerProfile.id);
            setHasApplied(applied);
          }
        }
      } catch (error) {
        logger.error('Error fetching branded cycle data', error as Error, { component: 'BrandedCycleRegistration', cycleId });
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [cycleId, slug, ownerType, user]);

  const handleSuccess = () => setIsSuccess(true);

  const isEnrollmentClosed = cycle && cycle.status !== 'open';
  const isDeadlinePassed = cycle?.enrollment_deadline && new Date(cycle.enrollment_deadline) < new Date();
  const canApply = cycle && !isEnrollmentClosed && !isDeadlinePassed && !hasApplied;

  const ownerTypeLabel = ownerType === 'academy' ? t('common:academy', 'Academy') : t('common:club', 'Club');
  const directoryPath = ownerType === 'academy' ? 'academies' : 'clubs';

  const breadcrumbs = [
    { label: t('common:home', 'Home'), path: '/' },
    { label: ownerType === 'academy' ? t('common:academies', 'Academies') : t('common:clubs', 'Clubs'), path: `/${directoryPath}` },
    ...(owner ? [{ label: owner.name, path: `/${directoryPath}/${owner.slug}` }] : []),
    { label: t('registration.title', 'Registration') },
  ];

  if (isLoading || authLoading) {
    return (
      <ProfileLayout breadcrumbs={breadcrumbs} showBackButton={false}>
        <div className="max-w-2xl mx-auto space-y-6">
          <Skeleton className="h-12 w-3/4" />
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-[400px]" />
        </div>
      </ProfileLayout>
    );
  }

  if (!cycle || !owner) {
    return (
      <ProfileLayout breadcrumbs={breadcrumbs} showBackButton>
        <div className="max-w-md mx-auto text-center py-12">
          <AlertCircle className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
          <h1 className="text-2xl font-bold mb-2">{t('registration.notFound')}</h1>
          <p className="text-muted-foreground mb-6">
            {t('registration.notFoundDesc', 'This registration could not be found or is no longer available.')}
          </p>
          <Button onClick={() => navigate('/')}>
            {t('common:backToHome', 'Back to homepage')}
          </Button>
        </div>
      </ProfileLayout>
    );
  }

  if (isSuccess) {
    return (
      <ProfileLayout breadcrumbs={breadcrumbs} bannerUrl={owner.banner_url} showBackButton={false}>
        <div className="max-w-md mx-auto text-center py-8">
          <div className="mx-auto h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
            <Calendar className="h-8 w-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold mb-2">{t('application.success.title')}</h1>
          <p className="text-muted-foreground mb-6">{t('application.success.message')}</p>
          <Card className="text-left mb-6">
            <CardHeader>
              <CardTitle className="text-base">{t('application.success.whatNext')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {[1, 2, 3].map(step => (
                <div key={step} className="flex gap-3">
                  <div className="flex-shrink-0 h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-xs font-medium">{step}</div>
                  <p className="text-sm text-muted-foreground">{t(`application.success.step${step}`)}</p>
                </div>
              ))}
            </CardContent>
          </Card>
          {owner.welcome_message && (
            <WelcomeMessageCard
              message={owner.welcome_message}
              ownerName={owner.name}
              labelKey={t('common:messageFrom', { name: owner.name, defaultValue: `Message from ${owner.name}` })}
            />
          )}
          {user ? (
            <Button onClick={() => navigate('/app/player')}>{t('application.success.backToProfile')}</Button>
          ) : (
            <Button onClick={() => navigate('/')}>{t('common:backToHome', 'Back to homepage')}</Button>
          )}
        </div>
      </ProfileLayout>
    );
  }

  const priceTable = cycle.price_table as { label: string; price: number }[] | null;

  return (
    <FeatureErrorBoundary featureName="BrandedCycleRegistration" onRetry={() => window.location.reload()}>
      <ProfileLayout breadcrumbs={breadcrumbs} bannerUrl={owner.banner_url} showBackButton={false}>
        <div className="max-w-2xl mx-auto">
          {/* Owner branding header */}
          <div className="flex items-center gap-3 mb-6">
            <Avatar className="h-14 w-14 border">
              <AvatarImage src={owner.logo_url || undefined} />
              <AvatarFallback>
                <Building2 className="h-6 w-6" />
              </AvatarFallback>
            </Avatar>
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide">{ownerTypeLabel}</p>
              <p className="font-semibold text-lg">{owner.name}</p>
            </div>
          </div>

          <Card className="mb-6">
            <CardContent className="pt-6 space-y-4">
              {/* Cycle header */}
              <h1 className="text-3xl font-bold">{cycle.name}</h1>

              {/* Meta info */}
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Calendar className="h-4 w-4" />
                  <span>
                    {format(new Date(cycle.start_date), 'd MMM', { locale: dateLocale })} - {format(new Date(cycle.end_date), 'd MMM yyyy', { locale: dateLocale })}
                  </span>
                </div>
                {cycle.enrollment_deadline && (
                  <div className="flex items-center gap-1.5 text-sm text-orange-600 dark:text-orange-400">
                    <Clock className="h-4 w-4" />
                    <span>
                      {t('registration.deadline', 'Deadline')}: {format(new Date(cycle.enrollment_deadline), 'd MMM yyyy', { locale: dateLocale })}
                    </span>
                  </div>
                )}
                {cycleLocation && (
                  <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <MapPin className="h-4 w-4" />
                    <span>{cycleLocation.name}, {cycleLocation.city}</span>
                  </div>
                )}
                <Badge variant={cycle.status === 'open' ? 'default' : 'secondary'}>
                  {t(`status.${cycle.status}`)}
                </Badge>
              </div>

              {/* Cycle details (description, location, price table, terms) */}
              <CycleDetailDisplay cycle={cycle} />
            </CardContent>
          </Card>


          {/* Status alerts */}
          {hasApplied && (
            <Alert className="my-6">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{t('application.alreadyApplied')}</AlertTitle>
              <AlertDescription>
                {t('application.alreadyAppliedDesc', 'You have already submitted an application for this cycle.')}
              </AlertDescription>
            </Alert>
          )}
          {isEnrollmentClosed && (
            <Alert variant="destructive" className="my-6">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{t('application.enrollmentClosed')}</AlertTitle>
            </Alert>
          )}
          {isDeadlinePassed && !isEnrollmentClosed && (
            <Alert variant="destructive" className="my-6">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{t('application.deadlinePassed')}</AlertTitle>
            </Alert>
          )}

          {/* Application form — always expanded */}
          {canApply && (
            <div className="mt-6">
              {user && profile ? (
                <CycleApplicationForm
                  cycle={cycle}
                  playerId={profile.id}
                  playerUserId={user.id}
                  playerName={profile.full_name || ''}
                  playerEmail={user.email || ''}
                  playerPhone={profile.phone || ''}
                  playerRating={profile.skill_rating ?? undefined}
                  playerRatingSystem={profile.rating_system || 'knltb'}
                  trainers={cycle.settings?.show_preferred_trainer ? trainers : undefined}
                  locations={locations.map(l => ({ id: l.id, name: l.name, city: l.city }))}
                  onSuccess={handleSuccess}
                />
              ) : (
                <CycleApplicationForm
                  cycle={cycle}
                  playerId=""
                  playerUserId=""
                  playerName=""
                  playerEmail=""
                  playerPhone=""
                  isGuest
                  trainers={cycle.settings?.show_preferred_trainer ? trainers : undefined}
                  locations={locations.map(l => ({ id: l.id, name: l.name, city: l.city }))}
                  onSuccess={handleSuccess}
                />
              )}
            </div>
          )}
        </div>
      </ProfileLayout>
    </FeatureErrorBoundary>
  );
}
