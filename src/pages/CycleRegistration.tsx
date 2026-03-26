import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { SEO } from '@/components/SEO';
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
import { Calendar, Clock, AlertCircle, MapPin, Building2, User } from 'lucide-react';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import CycleApplicationForm from '@/components/cycles/CycleApplicationForm';
import { getCycle, hasPlayerApplied, type Cycle } from '@/lib/cycles';
import { getActiveLocations, type Location } from '@/lib/locations';
import { logger } from '@/lib/logger';
import FeatureErrorBoundary from '@/components/FeatureErrorBoundary';

interface OwnerInfo {
  type: 'trainer' | 'club' | 'academy';
  name: string;
  avatar_url?: string;
  welcomeMessage?: string | null;
}

interface CycleLocation {
  name: string;
  city: string;
}

export default function CycleRegistration() {
  const { cycleId } = useParams<{ cycleId: string }>();
  const { t } = useTranslation('cycles');
  const { user, profile, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  const [cycle, setCycle] = useState<Cycle | null>(null);
  const [owner, setOwner] = useState<OwnerInfo | null>(null);
  const [cycleLocation, setCycleLocation] = useState<CycleLocation | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [trainers, setTrainers] = useState<{ id: string; name: string }[]>([]);
  const [hasApplied, setHasApplied] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSuccess, setIsSuccess] = useState(false);

  useEffect(() => {
    if (cycleId) {
      trackEvent('cycle_registration_viewed', { cycle_id: cycleId });
    }
  }, [cycleId]);

  useEffect(() => {
    const fetchData = async () => {
      if (!cycleId) return;

      setIsLoading(true);
      try {
        // Fetch cycle
        const cycleData = await getCycle(cycleId);
        if (!cycleData) {
          setCycle(null);
          return;
        }
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

        // Fetch owner info
        if (cycleData.owner_type === 'trainer') {
          const { data: trainerData } = await supabase
            .from('trainer_profiles')
            .select('id, user_id, welcome_message')
            .eq('id', cycleData.owner_id)
            .maybeSingle();

          if (trainerData) {
            const { data: profileData } = await supabase
              .from('profiles')
              .select('full_name, avatar_url')
              .eq('user_id', trainerData.user_id)
              .maybeSingle();

            setOwner({
              type: 'trainer',
              name: profileData?.full_name || 'Trainer',
              avatar_url: profileData?.avatar_url || undefined,
              welcomeMessage: trainerData.welcome_message,
            });
            setTrainers([{ id: trainerData.id, name: profileData?.full_name || 'Trainer' }]);
          }
        } else if (cycleData.owner_type === 'academy') {
          const { data: academyData } = await supabase
            .from('academy_profiles')
            .select('id, name, logo_url, welcome_message')
            .eq('id', cycleData.owner_id)
            .maybeSingle();

          if (academyData) {
            setOwner({
              type: 'academy',
              name: academyData.name,
              avatar_url: academyData.logo_url || undefined,
              welcomeMessage: academyData.welcome_message,
            });

            // Fetch academy trainers
            const { data: academyTrainers } = await supabase
              .from('academy_trainers')
              .select('trainer_profile_id')
              .eq('academy_profile_id', academyData.id)
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
                  const trainersList = trainerProfiles.map(tp => {
                    const prof = profiles.find(p => p.user_id === tp.user_id);
                    return { id: tp.id, name: prof?.full_name || 'Trainer' };
                  });
                  setTrainers(trainersList);
                }
              }
            }
          }
        } else {
          // Club owner type
          const { data: clubData } = await supabase
            .from('club_profiles')
            .select('id, location_id, welcome_message')
            .eq('id', cycleData.owner_id)
            .maybeSingle();

          if (clubData) {
            const { data: locationData } = await supabase
              .from('locations')
              .select('name')
              .eq('id', clubData.location_id)
              .maybeSingle();

            setOwner({
              type: 'club',
              name: locationData?.name || 'Club',
              welcomeMessage: clubData.welcome_message,
            });

            // Fetch club trainers
            const { data: clubTrainers } = await supabase
              .from('club_trainers' as any)
              .select('trainer_profile_id')
              .eq('club_profile_id', clubData.id)
              .eq('status', 'active');

            if (clubTrainers && clubTrainers.length > 0) {
              const trainerIds = (clubTrainers as any[]).map(ct => ct.trainer_profile_id);
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
                  const trainersList = trainerProfiles.map(tp => {
                    const prof = profiles.find(p => p.user_id === tp.user_id);
                    return { id: tp.id, name: prof?.full_name || 'Trainer' };
                  });
                  setTrainers(trainersList);
                }
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
        logger.error('Error fetching cycle data', error as Error, { component: 'CycleRegistration', cycleId });
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [cycleId, user]);

  const handleSuccess = () => {
    setIsSuccess(true);
  };

  const isEnrollmentClosed = cycle && cycle.status !== 'open';
  const isDeadlinePassed = cycle?.enrollment_deadline && new Date(cycle.enrollment_deadline) < new Date();
  const canApply = cycle && !isEnrollmentClosed && !isDeadlinePassed && !hasApplied;
  const priceTable = cycle?.price_table as { label: string; price: number }[] | null;

  if (isLoading || authLoading) {
    return (
      <MarketingLayout>
        <div className="container mx-auto px-4 py-12">
          <div className="max-w-2xl mx-auto space-y-6">
            <Skeleton className="h-12 w-3/4" />
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-[600px]" />
          </div>
        </div>
      </MarketingLayout>
    );
  }

  if (!cycle) {
    return (
      <MarketingLayout>
        <div className="container mx-auto px-4 py-12">
          <div className="max-w-md mx-auto text-center">
            <AlertCircle className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
            <h1 className="text-2xl font-bold mb-2">{t('registration.notFound')}</h1>
            <p className="text-muted-foreground mb-6">
              This registration cycle could not be found or is no longer available.
            </p>
            <Button onClick={() => navigate('/')}>
              Go to homepage
            </Button>
          </div>
        </div>
      </MarketingLayout>
    );
  }

  if (isSuccess) {
    return (
      <MarketingLayout>
        <div className="container mx-auto px-4 py-12">
          <div className="max-w-md mx-auto text-center">
            <div className="mx-auto h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <Calendar className="h-8 w-8 text-primary" />
            </div>
            <h1 className="text-2xl font-bold mb-2">{t('application.success.title')}</h1>
            <p className="text-muted-foreground mb-6">
              {t('application.success.message')}
            </p>
            <Card className="text-left mb-6">
              <CardHeader>
                <CardTitle className="text-base">{t('application.success.whatNext')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-3">
                  <div className="flex-shrink-0 h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-xs font-medium">1</div>
                  <p className="text-sm text-muted-foreground">{t('application.success.step1')}</p>
                </div>
                <div className="flex gap-3">
                  <div className="flex-shrink-0 h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-xs font-medium">2</div>
                  <p className="text-sm text-muted-foreground">{t('application.success.step2')}</p>
                </div>
                <div className="flex gap-3">
                  <div className="flex-shrink-0 h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-xs font-medium">3</div>
                  <p className="text-sm text-muted-foreground">{t('application.success.step3')}</p>
                </div>
              </CardContent>
            </Card>
            {owner?.welcomeMessage && (
              <WelcomeMessageCard
                message={owner.welcomeMessage}
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
        </div>
      </MarketingLayout>
    );
  }

  const ownerTypeLabel = owner?.type === 'academy' ? t('common:academy', 'Academy') : owner?.type === 'club' ? t('common:club', 'Club') : t('common:trainer', 'Trainer');

  return (
    <FeatureErrorBoundary featureName="CycleRegistration" onRetry={() => window.location.reload()}>
    {cycle && (
      <SEO
        title={`${cycle.name}${owner ? ` | ${owner.name}` : ''}`}
        description={[
          cycle.name,
          cycleLocation ? `${cycleLocation.name}, ${cycleLocation.city}` : '',
          owner?.name,
        ].filter(Boolean).join(' · ')}
        url={`/register/${cycleId}`}
        noIndex
      />
    )}
    <MarketingLayout>
      <div className="container mx-auto px-4 py-12">
        <div className="max-w-2xl mx-auto">
          {/* Cycle Header */}
          <Card className="mb-6">
            <CardContent className="pt-6 space-y-4">
              {/* Owner info */}
              {owner && (
                <div className="flex items-center gap-3">
                  <Avatar className="h-10 w-10">
                    <AvatarFallback>
                      {owner.type === 'trainer' ? <User className="h-5 w-5" /> : <Building2 className="h-5 w-5" />}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">{ownerTypeLabel}</p>
                    <p className="font-semibold text-lg">{owner.name}</p>
                  </div>
                </div>
              )}

              <h1 className="text-3xl font-bold">{cycle.name}</h1>
              
              {/* Meta info */}
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Calendar className="h-4 w-4" />
                  <span>
                    {format(new Date(cycle.start_date), 'MMM d')} - {format(new Date(cycle.end_date), 'MMM d, yyyy')}
                  </span>
                </div>
                {cycle.enrollment_deadline && (
                  <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Clock className="h-4 w-4" />
                    <span>
                      {t('application.deadline', 'Deadline')}: {format(new Date(cycle.enrollment_deadline), 'MMM d, yyyy')}
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

              {/* Description */}
              {cycle.description && (
                <div className="text-muted-foreground prose dark:prose-invert max-w-none" dangerouslySetInnerHTML={{ __html: cycle.description }} />
              )}

              {/* Price table */}
              {priceTable && priceTable.length > 0 && (
                <div className="border-t border-border pt-4">
                  <h3 className="text-base font-semibold mb-2">{t('application.pricing', 'Pricing')}</h3>
                  <div className="space-y-2">
                    {priceTable.map((tier, idx) => (
                      <div key={idx} className="flex items-center justify-between py-1.5 border-b border-border last:border-0">
                        <span className="text-sm">{tier.label}</span>
                        <span className="text-sm font-semibold">
                          {new Intl.NumberFormat('nl-NL', { style: 'currency', currency: cycle.currency || 'EUR' }).format(tier.price)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Status Alerts */}
          {hasApplied && (
            <Alert className="mb-6">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{t('application.alreadyApplied')}</AlertTitle>
              <AlertDescription>
                {t('application.alreadyAppliedDesc', 'You have already submitted an application for this cycle.')}
              </AlertDescription>
            </Alert>
          )}

          {isEnrollmentClosed && (
            <Alert variant="destructive" className="mb-6">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{t('application.enrollmentClosed')}</AlertTitle>
            </Alert>
          )}

          {isDeadlinePassed && !isEnrollmentClosed && (
            <Alert variant="destructive" className="mb-6">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{t('application.deadlinePassed')}</AlertTitle>
            </Alert>
          )}

          {/* Application Form - show for logged-in users AND guests */}
          {canApply && user && profile && (
            <CycleApplicationForm
              cycle={cycle}
              playerId={profile.id}
              playerUserId={user.id}
              playerName={profile.full_name || ''}
              playerEmail={user.email || ''}
              playerPhone={profile.phone || ''}
              playerRating={profile.skill_rating ?? undefined}
              playerRatingSystem={profile.rating_system || 'knltb'}
              playerBirthDate={(profile as any).birth_date || ''}
              trainers={cycle.settings?.show_preferred_trainer ? trainers.map(tr => ({ id: tr.id, name: tr.name })) : undefined}
              locations={locations.map(l => ({ id: l.id, name: l.name, city: l.city }))}
              onSuccess={handleSuccess}
            />
          )}

          {/* Guest form - allow filling out before creating account */}
          {canApply && !user && (
            <CycleApplicationForm
              cycle={cycle}
              playerId=""
              playerUserId=""
              playerName=""
              playerEmail=""
              playerPhone=""
              isGuest={true}
              trainers={cycle.settings?.show_preferred_trainer ? trainers.map(tr => ({ id: tr.id, name: tr.name })) : undefined}
              locations={locations.map(l => ({ id: l.id, name: l.name, city: l.city }))}
              onSuccess={handleSuccess}
            />
          )}
        </div>
      </div>
    </MarketingLayout>
    </FeatureErrorBoundary>
  );
}
