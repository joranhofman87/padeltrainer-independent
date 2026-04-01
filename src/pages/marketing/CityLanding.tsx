import { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '@/lib/supabaseClient';
import { useLocalizedPathFn, useCurrentLanguage } from '@/hooks/useLocalizedPath';
import { LocalizedLink } from '@/components/LocalizedLink';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { MapPin, Users, Star, ChevronRight, ChevronDown, ArrowRight } from 'lucide-react';
import { getActiveLocations, getLocationTrainerCounts, getClaimedLocationIds, type Location } from '@/lib/locations';
import { getCitiesWithTrainers, type CityWithTrainerCount } from '@/lib/cities';
import { LocationCard } from '@/components/locations/LocationCard';
import { SEO } from '@/components/SEO';
import { useTranslation } from 'react-i18next';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { logger } from '@/lib/logger';
import { generateCityIntro, generateLessonsText, generateFAQs } from '@/lib/cityContent';
import { getBatchTrainerRatings } from '@/lib/reviews';
import { getTrainerIdsInPaidAcademies } from '@/lib/academy';
import { Helmet } from 'react-helmet-async';
import { MARKETING_DOMAIN } from '@/lib/domains';

interface TrainerWithProfile {
  id: string;
  user_id: string;
  slug: string | null;
  experience_years: number | null;
  specializations: string[] | null;
  is_verified: boolean;
  profile: {
    full_name: string | null;
    avatar_url: string | null;
    bio: string | null;
  } | null;
  averageRating: number;
  reviewCount: number;
}

export default function CityLanding() {
  const { city } = useParams<{ city: string }>();
  const [locations, setLocations] = useState<Location[]>([]);
  const [trainers, setTrainers] = useState<TrainerWithProfile[]>([]);
  const [trainerCounts, setTrainerCounts] = useState<Record<string, number>>({});
  const [claimedLocationIds, setClaimedLocationIds] = useState<Set<string>>(new Set());
  const [nearbyCities, setNearbyCities] = useState<CityWithTrainerCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAllClubs, setShowAllClubs] = useState(false);
  const { t } = useTranslation('marketing');
  const localizePath = useLocalizedPathFn();
  const currentLang = useCurrentLanguage();

  const displayCity = useMemo(() => {
    if (!city) return '';
    return decodeURIComponent(city)
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }, [city]);

  useEffect(() => {
    if (city) fetchData();
  }, [city]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [allLocations, allTrainerCounts, allClaimedIds, allCities] = await Promise.all([
        getActiveLocations(),
        getLocationTrainerCounts(),
        getClaimedLocationIds(),
        getCitiesWithTrainers(),
      ]);

      const cityLocations = allLocations.filter(
        l => l.city.toLowerCase().replace(/\s+/g, '-') === city?.toLowerCase()
      );
      setLocations(cityLocations);
      setTrainerCounts(allTrainerCounts);
      setClaimedLocationIds(allClaimedIds);

      // Nearby cities
      const currentSlug = city?.toLowerCase();
      const nearby = allCities
        .filter(c => c.slug !== currentSlug && c.trainerCount > 0)
        .slice(0, 10);
      setNearbyCities(nearby);

      // Fetch trainers linked to locations in this city
      if (cityLocations.length > 0) {
        const locationIds = cityLocations.map(l => l.id);
        const now = new Date().toISOString();

        const { data: trainerLocationLinks } = await supabase
          .from('trainer_locations')
          .select('trainer_id')
          .in('location_id', locationIds);

        const trainerIdsAtLocations = new Set(trainerLocationLinks?.map(tl => tl.trainer_id) || []);

        if (trainerIdsAtLocations.size > 0) {
          const { data: trainerProfiles } = await supabase
            .from('trainer_profiles_safe')
            .select('id, user_id, slug, experience_years, specializations, is_verified, is_public, subscription_status, trial_ends_at')
            .eq('is_public', true)
            .in('id', Array.from(trainerIdsAtLocations));

          if (trainerProfiles && trainerProfiles.length > 0) {
            const allTrainerIds = trainerProfiles.map(t => t.id);
            const paidAcademyTrainerIds = await getTrainerIdsInPaidAcademies(allTrainerIds);

            const activeTrainers = trainerProfiles.filter(t =>
              t.subscription_status === 'active' ||
              (t.trial_ends_at && t.trial_ends_at > now) ||
              paidAcademyTrainerIds.has(t.id)
            );

            const userIds = activeTrainers.map(t => t.user_id);
            const { data: profiles } = await supabase
              .from('profiles_public')
              .select('user_id, full_name, avatar_url, bio')
              .in('user_id', userIds);

            const ratingsMap = await getBatchTrainerRatings(activeTrainers.map(t => t.id));

            const trainersWithProfiles = activeTrainers.map(trainer => ({
              ...trainer,
              profile: profiles?.find(p => p.user_id === trainer.user_id) || null,
              averageRating: ratingsMap.get(trainer.id)?.average || 0,
              reviewCount: ratingsMap.get(trainer.id)?.count || 0,
            }));

            setTrainers(trainersWithProfiles);
          }
        }
      }
    } catch (err) {
      logger.error('Error fetching city data', err as Error, { component: 'CityLanding' });
    } finally {
      setLoading(false);
    }
  };

  const visibleLocations = showAllClubs ? locations : locations.slice(0, 6);
  const totalTrainers = locations.reduce((sum, l) => sum + (trainerCounts[l.id] || 0), 0);

  const cityIntro = useMemo(
    () => generateCityIntro(displayCity, locations, trainerCounts, currentLang),
    [displayCity, locations, trainerCounts, currentLang]
  );

  const lessonsText = useMemo(
    () => generateLessonsText(displayCity, locations, trainerCounts, currentLang),
    [displayCity, locations, trainerCounts, currentLang]
  );

  const faqs = useMemo(
    () => generateFAQs(displayCity, locations.length, currentLang),
    [displayCity, locations.length, currentLang]
  );

  // SEO structured data
  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(faq => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: faq.answer,
      },
    })),
  };

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${MARKETING_DOMAIN}/${currentLang}` },
      { '@type': 'ListItem', position: 2, name: 'Padel', item: `${MARKETING_DOMAIN}/${currentLang}/padel` },
      { '@type': 'ListItem', position: 3, name: `Padel in ${displayCity}` },
    ],
  };

  const localBusinessSchemas = locations
    .filter(l => l.latitude && l.longitude)
    .map(l => ({
      '@context': 'https://schema.org',
      '@type': 'LocalBusiness',
      name: l.name,
      address: {
        '@type': 'PostalAddress',
        streetAddress: l.street_address || undefined,
        addressLocality: l.city,
        postalCode: l.postal_code || undefined,
        addressCountry: l.country,
      },
      geo: {
        '@type': 'GeoCoordinates',
        latitude: l.latitude,
        longitude: l.longitude,
      },
      url: `${MARKETING_DOMAIN}/${currentLang}/locations/${l.slug}`,
    }));

  const metaTitle = t('cityLanding.metaTitle', { city: displayCity });
  const metaDescription = t('cityLanding.metaDescription', { city: displayCity, count: locations.length });

  if (loading) {
    return (
      <MarketingLayout>
        <div className="flex min-h-[50vh] items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </MarketingLayout>
    );
  }

  return (
    <MarketingLayout>
      <SEO
        title={metaTitle}
        description={metaDescription}
        url={`/padel/${city}`}
        structuredData={[faqSchema, breadcrumbSchema, ...localBusinessSchemas]}
      />

      {/* Breadcrumb */}
      <div className="bg-muted/30">
        <div className="container mx-auto px-4 py-3">
          <nav className="text-sm text-muted-foreground" aria-label="Breadcrumb">
            <ol className="flex items-center gap-1.5">
              <li><LocalizedLink to="/" className="hover:text-foreground">Home</LocalizedLink></li>
              <li><ChevronRight className="h-3 w-3" /></li>
              <li><span className="text-foreground font-medium">Padel in {displayCity}</span></li>
            </ol>
          </nav>
        </div>
      </div>

      {/* Hero */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto px-4 text-center max-w-3xl">
          <h1 className="text-3xl md:text-4xl lg:text-5xl font-bold tracking-tight text-foreground mb-4">
            Padel in {displayCity}
          </h1>
          <p className="text-lg text-muted-foreground mb-8 max-w-2xl mx-auto">
            {t('cityLanding.heroSubtitle', { city: displayCity })}
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button size="lg" asChild>
              <a href="#clubs">{t('cityLanding.findCourt')}</a>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <a href="#trainers">{t('cityLanding.bookCoach')}</a>
            </Button>
          </div>

          {/* Quick stats */}
          {(locations.length > 0 || totalTrainers > 0) && (
            <div className="flex justify-center gap-8 mt-10">
              {locations.length > 0 && (
                <div className="text-center">
                  <div className="text-2xl font-bold text-primary">{locations.length}</div>
                  <div className="text-sm text-muted-foreground">{t('cityLanding.clubs')}</div>
                </div>
              )}
              {totalTrainers > 0 && (
                <div className="text-center">
                  <div className="text-2xl font-bold text-primary">{totalTrainers}</div>
                  <div className="text-sm text-muted-foreground">{t('cityLanding.coaches')}</div>
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* City intro */}
      <section className="py-12 bg-muted/30">
        <div className="container mx-auto px-4 max-w-3xl">
          <p className="text-base leading-relaxed text-muted-foreground">{cityIntro}</p>
        </div>
      </section>

      {/* Clubs section */}
      {locations.length > 0 && (
        <section id="clubs" className="py-16">
          <div className="container mx-auto px-4">
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight mb-8">
              {t('cityLanding.clubsHeading', { city: displayCity })}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {visibleLocations.map(location => (
                <LocationCard
                  key={location.id}
                  location={location}
                  trainerCount={trainerCounts[location.id] || 0}
                  isClaimed={claimedLocationIds.has(location.id)}
                  logoUrl={location.logo_url}
                />
              ))}
            </div>
            {locations.length > 6 && !showAllClubs && (
              <div className="mt-6 text-center">
                <Button variant="outline" onClick={() => setShowAllClubs(true)}>
                  {t('cityLanding.showAllClubs', { count: locations.length })}
                  <ChevronDown className="ml-2 h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Trainers section */}
      {trainers.length > 0 && (
        <section id="trainers" className="py-16 bg-muted/30">
          <div className="container mx-auto px-4">
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight mb-8">
              {t('cityLanding.trainersHeading', { city: displayCity })}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {trainers.slice(0, 6).map(trainer => (
                <LocalizedLink
                  key={trainer.id}
                  to={`/trainer/${trainer.slug || trainer.user_id}`}
                  className="block"
                >
                  <Card className="hover:shadow-lg transition-shadow hover:border-primary/50 h-full">
                    <CardHeader className="pb-2">
                      <div className="flex items-start gap-3">
                        <Avatar className="h-12 w-12 shrink-0">
                          <AvatarImage src={trainer.profile?.avatar_url || undefined} alt={trainer.profile?.full_name || ''} />
                          <AvatarFallback className="bg-primary/10 text-primary">
                            {(trainer.profile?.full_name || '?').slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <CardTitle className="text-lg">{trainer.profile?.full_name || t('cityLanding.unknownTrainer')}</CardTitle>
                          {trainer.averageRating > 0 && (
                            <div className="flex items-center gap-1 mt-1">
                              <Star className="h-3.5 w-3.5 fill-yellow-400 text-yellow-400" />
                              <span className="text-sm font-medium">{trainer.averageRating.toFixed(1)}</span>
                              <span className="text-xs text-muted-foreground">({trainer.reviewCount})</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      {trainer.profile?.bio && (
                        <p className="text-sm text-muted-foreground line-clamp-2">{trainer.profile.bio}</p>
                      )}
                      {trainer.specializations && trainer.specializations.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {trainer.specializations.slice(0, 3).map(spec => (
                            <Badge key={spec} variant="secondary" className="text-xs">{spec}</Badge>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </LocalizedLink>
              ))}
            </div>
            <div className="mt-6 text-center">
              <Button variant="outline" asChild>
                <LocalizedLink to={`/trainers/${city}`}>
                  {t('cityLanding.viewAllTrainers', { city: displayCity })}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </LocalizedLink>
              </Button>
            </div>
          </div>
        </section>
      )}

      {/* Padel lessons section */}
      <section className="py-16">
        <div className="container mx-auto px-4 max-w-3xl">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight mb-6">
            {t('cityLanding.lessonsHeading', { city: displayCity })}
          </h2>
          <p className="text-base leading-relaxed text-muted-foreground mb-8">{lessonsText}</p>
          <Button size="lg" asChild>
            <LocalizedLink to="/pricing">
              {t('cityLanding.startTrial')}
              <ArrowRight className="ml-2 h-4 w-4" />
            </LocalizedLink>
          </Button>
        </div>
      </section>

      {/* FAQ section */}
      <section className="py-16 bg-muted/30">
        <div className="container mx-auto px-4 max-w-3xl">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight mb-8">
            {t('cityLanding.faqHeading', { city: displayCity })}
          </h2>
          <Accordion type="single" collapsible className="w-full">
            {faqs.map((faq, i) => (
              <AccordionItem key={i} value={`faq-${i}`}>
                <AccordionTrigger className="text-left font-medium">{faq.question}</AccordionTrigger>
                <AccordionContent className="text-muted-foreground">{faq.answer}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>

      {/* Nearby cities */}
      {nearbyCities.length > 0 && (
        <section className="py-12">
          <div className="container mx-auto px-4">
            <h3 className="text-lg font-semibold mb-4">{t('cityLanding.nearbyCities')}</h3>
            <div className="flex flex-wrap gap-2">
              {nearbyCities.map(nc => (
                <LocalizedLink
                  key={nc.slug}
                  to={`/padel/${nc.slug}`}
                  className="inline-flex"
                >
                  <Badge variant="outline" className="hover:bg-primary/10 transition-colors cursor-pointer px-3 py-1.5">
                    Padel in {nc.city}
                  </Badge>
                </LocalizedLink>
              ))}
            </div>
          </div>
        </section>
      )}
    </MarketingLayout>
  );
}
