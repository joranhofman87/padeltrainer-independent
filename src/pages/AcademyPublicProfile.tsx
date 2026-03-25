import { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { 
  MapPin, Users, Star, ExternalLink, Calendar, Share2, Copy, Check, 
  MessageCircle, CheckCircle, Award
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { SEO } from '@/components/SEO';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import {
  ProfileLayout,
  ProfileContentGrid,
  ProfileMainColumn,
  ProfileSidebarColumn,
  ProfileFullWidthSection,
  ProfileHeroCard,
  VideoGallery,
  VideoGallery,
} from '@/components/profiles';
import { 
  getAcademyBySlug, 
  getPublicAcademyTrainers, 
  getPublicAcademyLocations,
  recordAcademyProfileView,
  type AcademyProfile 
} from '@/lib/academy';
import { AcademyOpenCycles } from '@/components/academy/AcademyOpenCycles';
import { AcademyPublicOpenSlots } from '@/components/academy/AcademyPublicOpenSlots';
import { WaitingListCard } from '@/components/waitingList';
import { AcademyReviews } from '@/components/reviews/AcademyReviews';
import { useLocalizedPathFn, useCurrentLanguage } from '@/hooks/useLocalizedPath';
import { useAuth } from '@/hooks/useAuth';
import { getMarketingUrl, MARKETING_DOMAIN } from '@/lib/domains';
import { trackEvent } from '@/lib/tracking';
import { logger } from '@/lib/logger';

interface TrainerData {
  id: string;
  trainer_profile_id: string;
  trainer_profile: {
    id: string;
    user_id: string;
    slug: string | null;
    hourly_rate: number | null;
    experience_years: number | null;
    is_verified: boolean;
  };
  profile: {
    full_name: string | null;
    avatar_url: string | null;
    bio: string | null;
    location: string | null;
  } | null;
  avgRating?: number;
}

interface LocationData {
  id: string;
  location_id: string;
  contract_type: string;
  location: {
    id: string;
    name: string;
    city: string;
    slug: string;
    logo_url: string | null;
    street_address: string | null;
    postal_code: string | null;
  };
}

export default function AcademyPublicProfile() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isPreview = searchParams.get('preview') === 'true';
  const { t } = useTranslation(['academy', 'common']);
  const { user } = useAuth();
  const localizePath = useLocalizedPathFn();
  const currentLang = useCurrentLanguage();

  const [copied, setCopied] = useState(false);

  const profileUrl = getMarketingUrl(`academies/${slug}`, currentLang);

  // Cached academy data
  const { data: academy, isLoading: academyLoading } = useQuery({
    queryKey: ['academy-public', slug],
    queryFn: async () => {
      if (!slug) return null;
      const data = await getAcademyBySlug(slug, isPreview);
      if (!data) return null;
      if (!isPreview && !data.is_public) return null;
      return data;
    },
    enabled: !!slug,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });

  // Parallel cached queries for trainers and locations
  const { data: trainers = [] } = useQuery<TrainerData[]>({
    queryKey: ['academy-public-trainers', academy?.id],
    queryFn: () => getPublicAcademyTrainers(academy!.id),
    enabled: !!academy?.id,
    staleTime: 5 * 60 * 1000,
  });

  const { data: locations = [] } = useQuery<LocationData[]>({
    queryKey: ['academy-public-locations', academy?.id],
    queryFn: () => getPublicAcademyLocations(academy!.id),
    enabled: !!academy?.id,
    staleTime: 5 * 60 * 1000,
  });

  // Record view (fire-and-forget)
  useEffect(() => {
    if (academy?.id) {
      recordAcademyProfileView(academy.id);
      trackEvent('academy_profile_viewed', { academy_id: academy.id, academy_slug: slug });
    }
  }, [academy?.id]);

  // Redirect if not found after loading
  useEffect(() => {
    if (!academyLoading && academy === null && slug) {
      navigate(localizePath('/academies'));
    }
  }, [academyLoading, academy, slug]);

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(profileUrl);
      setCopied(true);
      toast.success(t('common:linkCopied', 'Link copied!'));
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      toast.error('Failed to copy link');
    }
  };

  const handleShareWhatsApp = () => {
    const message = encodeURIComponent(`${academy?.name} - ${profileUrl}`);
    window.open(`https://wa.me/?text=${message}`, '_blank');
  };

  const getInitials = (name: string | null | undefined) => {
    if (!name) return 'A';
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };


  const breadcrumbs = [
    { label: t('common:navigation.home'), path: '/' },
    { label: t('common:academies', 'Academies'), path: '/academies' },
    { label: academy?.name || '' },
  ];

  const structuredData = academy ? [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": t('common:navigation.home'), "item": `${MARKETING_DOMAIN}/${currentLang}` },
        { "@type": "ListItem", "position": 2, "name": t('common:academies', 'Academies'), "item": `${MARKETING_DOMAIN}/${currentLang}/academies` },
        { "@type": "ListItem", "position": 3, "name": academy.name }
      ]
    },
    {
      "@context": "https://schema.org",
      "@type": "EducationalOrganization",
      "name": academy.name,
      "description": academy.description,
      "url": profileUrl,
      "logo": academy.logo_url,
      "image": academy.banner_url || academy.logo_url,
      "numberOfEmployees": trainers.length,
      ...(academy.website_url && { "sameAs": [
        academy.website_url,
        ...(academy.social_instagram ? [`https://instagram.com/${academy.social_instagram.replace('@', '')}`] : []),
        ...(academy.social_facebook ? [academy.social_facebook] : []),
        ...(academy.social_linkedin ? [academy.social_linkedin] : []),
      ]}),
      ...(locations.length > 0 && {
        "areaServed": {
          "@type": "GeoCircle",
          "geoMidpoint": { "@type": "GeoCoordinates", "addressCountry": "NL" }
        }
      }),
      "member": trainers.slice(0, 5).map(t => ({
        "@type": "Person",
        "name": t.profile?.full_name,
        "jobTitle": "Padel Trainer"
      }))
    }
  ] : undefined;

  if (academyLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!academy) {
    return (
      <ProfileLayout>
        <div className="text-center py-12">
          <h1 className="text-2xl font-bold mb-2">{t('common:notFound', 'Not Found')}</h1>
          <p className="text-muted-foreground mb-4">{t('common:academyNotFound', "This academy doesn't exist or is not public.")}</p>
          <Button onClick={() => navigate(localizePath('/academies'))}>{t('common:browseAcademies', 'Browse Academies')}</Button>
        </div>
      </ProfileLayout>
    );
  }

  return (
    <>
      <SEO
        title={t('marketing:seo.academy.title', { 
          name: academy.name, 
          city: locations[0]?.location?.city ? ` in ${locations[0].location.city}` : '' 
        })}
        description={t('marketing:seo.academy.description', {
          name: academy.name,
          trainers: trainers.length,
          trainerPlural: trainers.length !== 1 ? 's' : '',
          locations: locations.length,
          locationPlural: locations.length !== 1 ? 's' : ''
        })}
        url={`/academies/${slug}`}
        image={academy.logo_url || academy.banner_url || undefined}
        structuredData={structuredData}
      />

      <ProfileLayout
        breadcrumbs={breadcrumbs}
        bannerUrl={academy.banner_url}
        showBackButton={false}
        headerAction={
          !user ? (
            <Button onClick={() => navigate(localizePath('/auth'))}>{t('common:signIn')}</Button>
          ) : null
        }
      >
        <ProfileHeroCard
          name={academy.name}
          avatarUrl={academy.logo_url}
          avatarAlt={`${academy.name} logo`}
          statsSlot={
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <span className="flex items-center gap-1">
                <Users className="h-4 w-4" />
                {trainers.length} {t('stats.trainers')}
              </span>
              <span className="flex items-center gap-1">
                <MapPin className="h-4 w-4" />
                {locations.length} {t('stats.locations')}
              </span>
            </div>
          }
        />

        {/* Open Registrations & Slots */}
        <div className="space-y-4 mt-4">
          <AcademyOpenCycles 
            academyId={academy.id!}
            academyName={academy.name || 'Academy'}
            academySlug={academy.slug || ''}
          />

          <AcademyPublicOpenSlots
            academyId={academy.id!}
            academySlug={academy.slug || ''}
          />

          {(academy as any).waiting_list_enabled && (
            <WaitingListCard
              ownerType="academy"
              ownerId={academy.id!}
              ownerName={academy.name || 'Academy'}
            />
          )}
        </div>

        {/* Full Width - Locations Section */}
        {locations.length > 0 && (
          <ProfileFullWidthSection>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-semibold flex items-center gap-2">
                <MapPin className="h-6 w-6 text-primary" />
                {t('locations.title')}
              </h2>
              <Badge variant="secondary" className="text-sm">
                {locations.length} {locations.length === 1 ? t('common:location', 'Location') : t('stats.locations')}
              </Badge>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {locations.map(loc => (
                <Card
                  key={loc.id}
                  className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
                  onClick={() => navigate(localizePath(`/locations/${loc.location.slug}`))}
                >
                  <CardContent className="pt-6">
                    <div className="flex items-start gap-4">
                      <Avatar className="h-14 w-14 rounded-lg">
                        <AvatarImage src={loc.location.logo_url || ''} />
                        <AvatarFallback className="rounded-lg">{getInitials(loc.location.name)}</AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold truncate">{loc.location.name}</h3>
                        <p className="text-sm text-muted-foreground flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {loc.location.city}
                        </p>
                        {loc.contract_type === 'exclusive' && (
                          <Badge variant="outline" className="mt-2 text-xs">
                            <Award className="h-3 w-3 mr-1" />
                            {t('locations.exclusive')}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </ProfileFullWidthSection>
        )}

        {/* Full Width - Trainers Section */}
        {trainers.length > 0 && (
          <ProfileFullWidthSection>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-semibold flex items-center gap-2">
                <Users className="h-6 w-6 text-primary" />
                {t('trainers.title')}
              </h2>
              <Badge variant="secondary" className="text-sm">
                {trainers.length} {trainers.length === 1 ? t('common:trainer', 'Trainer') : t('stats.trainers')}
              </Badge>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {trainers.map(trainer => (
                <Card
                  key={trainer.id}
                  className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
                  onClick={() => navigate(localizePath(`/trainer/${trainer.trainer_profile?.slug || trainer.trainer_profile?.id}`))}
                >
                  <CardContent className="pt-6">
                    <div className="flex items-start gap-4">
                      <Avatar className="h-14 w-14">
                        <AvatarImage src={trainer.profile?.avatar_url || ''} />
                        <AvatarFallback>{getInitials(trainer.profile?.full_name)}</AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold truncate">{trainer.profile?.full_name}</h3>
                          {trainer.trainer_profile?.is_verified && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <CheckCircle className="h-4 w-4 text-green-500 flex-shrink-0" />
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>{t('common:verifiedProfile', 'Verified profile')}</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                        </div>
                        {trainer.profile?.location && (
                          <p className="text-sm text-muted-foreground flex items-center gap-1">
                            <MapPin className="h-3 w-3" />
                            {trainer.profile.location}
                          </p>
                        )}
                        <div className="flex items-center gap-3 mt-2 text-sm">
                          {trainer.avgRating && (
                            <span className="flex items-center gap-1 text-yellow-600">
                              <Star className="h-3 w-3 fill-current" />
                              {trainer.avgRating.toFixed(1)}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </ProfileFullWidthSection>
        )}

        {/* About */}
        {academy.description && (
          <ProfileFullWidthSection>
            <Card>
              <CardHeader>
                <CardTitle>{t('common:aboutAcademy', 'About')} {academy.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground whitespace-pre-line">{academy.description}</p>
              </CardContent>
            </Card>
          </ProfileFullWidthSection>
        )}

        {/* Reviews */}
        {academy.id && <AcademyReviews academyId={academy.id} />}
      </ProfileLayout>
    </>
  );
}
