import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { SEO } from '@/components/SEO';
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
import { Calendar, Clock, AlertCircle, MapPin } from 'lucide-react';
import CycleApplicationForm from '@/components/cycles/CycleApplicationForm';
import CycleDetailDisplay from '@/components/cycles/CycleDetailDisplay';
import { ProfileLayout } from '@/components/profiles/ProfileLayout';
import { getPublicCycle, hasPlayerApplied, type Cycle } from '@/lib/cycles';
import { getRegistration, registrationToCycle } from '@/lib/registrations';
import type { RegTrainerOption } from '@/lib/registrationTrainerDisplay';
import { getActiveLocations, type Location } from '@/lib/locations';
import { logger } from '@/lib/logger';
import FeatureErrorBoundary from '@/components/FeatureErrorBoundary';
import { QueryErrorState } from '@/components/ui/QueryErrorState';

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
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const dateLocale = i18n.language === 'nl' ? nl : enUS;

  const [cycle, setCycle] = useState<Cycle | null>(null);
  const [owner, setOwner] = useState<OwnerBranding | null>(null);
  const [cycleLocation, setCycleLocation] = useState<{ name: string; city: string; logo_url: string | null } | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [trainers, setTrainers] = useState<RegTrainerOption[]>([]);
  const [hasApplied, setHasApplied] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  useEffect(() => {
    if (cycleId) {
      trackEvent('branded_cycle_registration_viewed', { cycle_id: cycleId, owner_type: ownerType, slug });
    }
  }, [cycleId, ownerType, slug]);

  // Public data fetch — runs immediately, no auth dependency
  const fetchPublicData = useCallback(async () => {
    if (!cycleId || !slug) return;
    setIsLoading(true);
    setLoadFailed(false);

    try {
      // Parallel: fetch owner branding + cycle data. Query errors must throw —
      // a failed request is retryable, only a successful empty result is a
      // genuine "not found".
      const ownerPromise = ownerType === 'academy'
        ? supabase
            .from('academy_profiles_safe' as any)
            .select('id, name, slug, logo_url, banner_url, welcome_message')
            .eq('slug', slug)
            .maybeSingle()
            .then(({ data, error }: any) => {
              if (error) throw error;
              return data;
            })
        : supabase
            .from('club_profiles_safe' as any)
            .select('id, logo_url, banner_url, welcome_message, location_id')
            .eq('id', slug)
            .maybeSingle()
            .then(async ({ data: club, error }: any) => {
              if (error) throw error;
              if (!club) return null;
              const { data: loc } = await supabase
                .from('locations')
                .select('name')
                .eq('id', club.location_id)
                .maybeSingle();
              return {
                name: loc?.name || 'Club',
                slug: slug!,
                logo_url: club.logo_url,
                banner_url: club.banner_url,
                welcome_message: club.welcome_message,
              } as OwnerBranding;
            });

      // Dual-read (registration↔cycle split): resolve the FORM from the new `registrations`
      // table by the canonical registration id OR the legacy source-cycle id (already-shared
      // branded links + printed QR). On a legacy match, redirect to the canonical id; otherwise
      // fall back to the cycle (pre-backfill / plain cyclus-event) — unchanged behaviour.
      const reg = await getRegistration(cycleId);
      if (reg && reg.id !== cycleId) {
        navigate(window.location.pathname.replace(cycleId, reg.id) + window.location.search, {
          replace: true,
        });
        return;
      }
      const cyclePromise = reg ? Promise.resolve(registrationToCycle(reg)) : getPublicCycle(cycleId);

      const [ownerData, cycleData] = await Promise.all([ownerPromise, cyclePromise]);

      if (ownerData) setOwner(ownerData as OwnerBranding);
      if (!cycleData) { setCycle(null); setIsLoading(false); return; }
      setCycle(cycleData);

      // Fetch cycle location first (critical for above-the-fold UI)
      const locationPromise = cycleData.location_id
        ? supabase
            .from('locations')
            .select('name, city, logo_url')
            .eq('id', cycleData.location_id)
            .maybeSingle()
            .then(({ data }) => data)
        : Promise.resolve(null);

      const locData = await locationPromise;
      if (locData) setCycleLocation(locData);

      // Render now; fetch heavier form helpers in background
      setIsLoading(false);

      const trainersPromise = ownerType === 'academy'
        ? (async () => {
            // Anon-readable view + safe views — base tables are not anon-readable.
            const { data: academyTrainers } = await supabase
              .from('academy_trainers_public')
              .select('trainer_profile_id')
              .eq('academy_profile_id', cycleData.owner_id);
            if (!academyTrainers?.length) return [];
            const trainerIds = academyTrainers.map(at => at.trainer_profile_id);
            const { data: trainerProfiles } = await supabase
              .from('trainer_profiles_safe')
              .select('id, user_id, slug, specializations')
              .in('id', trainerIds);
            if (!trainerProfiles) return [];
            const userIds = trainerProfiles.map(tp => tp.user_id);
            const { data: profiles } = await supabase
              .from('profiles_public')
              .select('user_id, full_name, avatar_url, location')
              .in('user_id', userIds);
            // Richer options → the form can render trainer profile cards + link to /trainer/:slug.
            return trainerProfiles.map(tp => {
              const prof = (profiles ?? []).find(p => p.user_id === tp.user_id);
              return {
                id: tp.id,
                name: prof?.full_name || 'Trainer',
                avatarUrl: prof?.avatar_url ?? null,
                location: prof?.location ?? null,
                slug: (tp as { slug?: string | null }).slug ?? null,
                specializations: (tp as { specializations?: string[] | null }).specializations ?? null,
              };
            });
          })()
        : Promise.resolve([]);

      const locationsPromise = getActiveLocations();
      const [trainersData, locationsData] = await Promise.all([trainersPromise, locationsPromise]);

      setTrainers(trainersData);
      setLocations(locationsData);
    } catch (error) {
      logger.error('Error fetching branded cycle data', error as Error, { component: 'BrandedCycleRegistration', cycleId });
      setLoadFailed(true);
    } finally {
      setIsLoading(false);
    }
  }, [cycleId, slug, ownerType, navigate]);

  useEffect(() => {
    fetchPublicData();
  }, [fetchPublicData]);

  // Auth-dependent check — runs separately when user changes
  useEffect(() => {
    const checkApplied = async () => {
      if (!user || !cycleId) return;
      try {
        const { data: playerProfile } = await supabase
          .from('profiles')
          .select('id')
          .eq('user_id', user.id)
          .maybeSingle();
        if (playerProfile) {
          const applied = await hasPlayerApplied(cycleId, playerProfile.id);
          setHasApplied(applied);
        }
      } catch (error) {
        logger.warn('Error checking application status', { error });
      }
    };
    checkApplied();
  }, [user, cycleId]);

  const handleSuccess = () => setIsSuccess(true);

  const isEnrollmentClosed = cycle && cycle.status !== 'open';
  const isDeadlinePassed = !!(!cycle?.is_always_open && cycle?.enrollment_deadline && new Date(cycle.enrollment_deadline) < new Date());
  const canApply = cycle && !isEnrollmentClosed && !hasApplied;
  const isWaitlistMode = !!(canApply && isDeadlinePassed);

  const directoryPath = ownerType === 'academy' ? 'academies' : 'clubs';

  const breadcrumbs = [
    { label: t('common:navigation.home', 'Home'), path: '/' },
    { label: ownerType === 'academy' ? t('common:academies', 'Academies') : t('common:clubs', 'Clubs'), path: `/${directoryPath}` },
    ...(owner ? [{ label: owner.name, path: `/${directoryPath}/${owner.slug}` }] : []),
    { label: t('common:breadcrumbs.registration', 'Registration') },
  ];

  if (isLoading) {
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

  if (loadFailed) {
    return (
      <ProfileLayout breadcrumbs={breadcrumbs} showBackButton={false}>
        <div className="max-w-md mx-auto py-12">
          <QueryErrorState
            onRetry={fetchPublicData}
            title={t('registration.loadFailedTitle', 'Could not load this registration')}
            description={t('registration.loadFailedDescription', 'Something went wrong while loading. Your registration link is still valid — check your connection and try again.')}
          />
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
          {(cycle?.settings as any)?.success_message && (
            <Card className="text-left mb-6 border-primary/20 bg-primary/5">
              <CardContent className="pt-6">
                <p className="text-sm whitespace-pre-line">{(cycle.settings as any).success_message}</p>
              </CardContent>
            </Card>
          )}
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
          <div className="flex flex-col gap-2">
            <Button variant="outline" onClick={() => { setIsSuccess(false); setHasApplied(false); }}>
              {t('application.success.backToForm', 'Back to form')}
            </Button>
          </div>
        </div>
      </ProfileLayout>
    );
  }

  return (
    <FeatureErrorBoundary featureName="BrandedCycleRegistration" onRetry={() => window.location.reload()}>
      {cycle && owner && (
        <SEO
          title={`${cycle.name} | ${owner.name}`}
          description={[
            cycle.name,
            cycleLocation ? `${cycleLocation.name}, ${cycleLocation.city}` : '',
            owner.name,
          ].filter(Boolean).join(' · ')}
          url={`/${directoryPath}/${slug}/register/${cycleId}`}
          noIndex
        />
      )}
      <ProfileLayout breadcrumbs={breadcrumbs} bannerUrl={owner.banner_url} showBackButton={false}>
        <div className="max-w-2xl mx-auto">
          {/* Location at top */}
          {cycleLocation && (
            <div className="flex items-center gap-2 mb-4">
              {cycleLocation.logo_url ? (
                <Avatar className="h-8 w-8 shrink-0 border">
                  <AvatarImage src={cycleLocation.logo_url} alt={cycleLocation.name} />
                  <AvatarFallback><MapPin className="h-4 w-4" /></AvatarFallback>
                </Avatar>
              ) : (
                <MapPin className="h-5 w-5 text-primary shrink-0" />
              )}
              <span className="font-semibold text-base">{cycleLocation.name}</span>
            </div>
          )}

          {/* Cycle title + meta */}
          <div className="mb-6 space-y-2">
            <h1 className="text-lg sm:text-xl font-semibold">{cycle.name}</h1>

            {/* Compact meta row */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {cycle.is_always_open ? (
                <Badge variant="secondary">{t('alwaysOpen.badge', 'Always open')}</Badge>
              ) : (
                <>
                  {cycle.start_date && cycle.end_date && (
                    <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                      <Calendar className="h-4 w-4" />
                      <span>
                        {format(new Date(cycle.start_date), 'd MMM', { locale: dateLocale })} - {format(new Date(cycle.end_date), 'd MMM yyyy', { locale: dateLocale })}
                      </span>
                    </div>
                  )}
                  {cycle.enrollment_deadline && (
                    <div className="flex items-center gap-1.5 text-sm text-orange-600 dark:text-orange-400">
                      <Clock className="h-4 w-4" />
                      <span>
                        {t('registration.deadline', 'Deadline')}: {format(new Date(cycle.enrollment_deadline), 'd MMM yyyy', { locale: dateLocale })}
                      </span>
                    </div>
                  )}
                </>
              )}
              <Badge variant={cycle.status === 'open' ? 'default' : 'secondary'}>
                {t(`status.${cycle.status}`)}
              </Badge>
            </div>
          </div>

          {/* Details card (description, price table, terms) — only if content exists */}
          <CycleDetailDisplay cycle={cycle} hideLocation />
          {(cycle.description || (cycle.price_table as any[])?.length > 0 || cycle.terms) && (
            <div className="mb-6" />
          )}


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
          {isWaitlistMode && (
            <Alert className="my-6">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{t('application.deadlinePassed')}</AlertTitle>
              <AlertDescription>
                {t('application.deadlinePassedWaitlist', "The deadline has passed — you'll be added to the waiting list.")}
              </AlertDescription>
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
                  playerFirstName={profile.first_name}
                  playerLastName={profile.last_name}
                  playerEmail={user.email || ''}
                  playerPhone={profile.phone || ''}
                  playerRating={profile.skill_rating ?? undefined}
                  playerRatingSystem={profile.rating_system || 'knltb'}
                  playerBirthDate={(profile as any).birth_date || ''}
                  trainers={trainers}
                  locations={locations.map(l => ({ id: l.id, name: l.name, city: l.city }))}
                  isWaitlist={isWaitlistMode}
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
                  trainers={trainers}
                  locations={locations.map(l => ({ id: l.id, name: l.name, city: l.city }))}
                  isWaitlist={isWaitlistMode}
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
