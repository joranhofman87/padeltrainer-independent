import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { LocalizedLink } from '@/components/LocalizedLink';
import { MapPin, ExternalLink, Loader2, Star, Users, Building2, CheckCircle, LayoutGrid, Calendar, Settings, Mail, Share2, Copy, Check, MessageCircle, GraduationCap, Award, Home, Sun } from 'lucide-react';
import { LocationOpenCycles } from '@/components/club/LocationOpenCycles';
import { WaitingListCard } from '@/components/waitingList';
import { UpcomingTournaments } from '@/components/club/UpcomingTournaments';
import { useLocalizedPathFn, useCurrentLanguage } from '@/hooks/useLocalizedPath';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SEO } from '@/components/SEO';
import { logger } from '@/lib/logger';
import { FollowButton } from '@/components/trainers/FollowButton';
import { getLocationBySlug, getTrainersAtLocation, getClubProfileByLocationId, type Location } from '@/lib/locations';
import { LocationCard } from '@/components/locations/LocationCard';
import { isLocationClaimed, isUserClubManager } from '@/lib/club';
import { getAcademiesAtLocation } from '@/lib/academy';
import { recordClubProfileView } from '@/lib/clubProfileViews';
import { ClaimClubDialog } from '@/components/club/ClaimClubDialog';
import { ClubFollowButton } from '@/components/club/ClubFollowButton';
import { supabase } from '@/lib/supabaseClient';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { format } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { toast } from 'sonner';
import {
  ProfileLayout,
  ProfileContentGrid,
  ProfileMainColumn,
  ProfileSidebarColumn,
  ProfileFullWidthSection,
  ProfileHeroCard,
  ProfileQuickStatsCard,
} from '@/components/profiles';
import { getMarketingUrl } from '@/lib/domains';
import { SponsorBanner } from '@/components/sponsors/SponsorBanner';

interface TrainerWithProfile {
  id: string;
  is_primary: boolean;
  trainer_id: string;
  trainer_profiles: {
    id: string;
    user_id: string;
    slug: string | null;
    hourly_rate: number | null;
    experience_years: number | null;
    specializations: string[] | null;
    certifications: string[] | null;
    is_verified: boolean | null;
  };
  profile?: {
    full_name: string | null;
    avatar_url: string | null;
    bio: string | null;
    location: string | null;
    skill_rating: number | null;
    rating_system: string | null;
  };
  avgRating?: number;
}

interface ClubProfile {
  id: string;
  location_id: string;
  description: string | null;
  banner_url: string | null;
  logo_url: string | null;
  is_verified: boolean;
  claimed_at: string;
  created_at?: string;
  updated_at?: string;
  subscription_status?: string | null;
  subscription_tier?: string | null;
  social_instagram?: string | null;
  social_facebook?: string | null;
  social_tiktok?: string | null;
  social_youtube?: string | null;
  social_linkedin?: string | null;
}

export default function LocationDetail() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation(['common', 'club']);
  const { user } = useAuth();
  const localizePath = useLocalizedPathFn();
  const currentLang = useCurrentLanguage();
  const [location, setLocation] = useState<Location | null>(null);
  const [clubProfile, setClubProfile] = useState<ClubProfile | null>(null);
  const [trainers, setTrainers] = useState<TrainerWithProfile[]>([]);
  const [academies, setAcademies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isClaimed, setIsClaimed] = useState(false);
  const [isManager, setIsManager] = useState(false);
  const [showClaimDialog, setShowClaimDialog] = useState(false);
  const [copied, setCopied] = useState(false);
  const [similarLocations, setSimilarLocations] = useState<Location[]>([]);
  const [similarTrainerCounts, setSimilarTrainerCounts] = useState<Record<string, number>>({});
  const [similarClaimedIds, setSimilarClaimedIds] = useState<Set<string>>(new Set());
  const [similarLogos, setSimilarLogos] = useState<Record<string, string>>({});

  const dateLocale = i18n.language === 'nl' ? nl : enUS;
  const profileUrl = location ? getMarketingUrl(`locations/${slug}`, currentLang) : '';

  useEffect(() => {
    async function fetchData() {
      if (!slug) return;

      try {
        const locationData = await getLocationBySlug(slug);
        if (!locationData) {
          navigate(localizePath('/locations'));
          return;
        }

        const [claimed, clubProfileData] = await Promise.all([
          isLocationClaimed(locationData.id),
          getClubProfileByLocationId(locationData.id),
        ]);
        setIsClaimed(claimed);
        setClubProfile(clubProfileData as ClubProfile | null);
        setLocation(locationData);

        if (user && clubProfileData) {
          const managerStatus = await isUserClubManager(user.id);
          setIsManager(managerStatus);
        }

        const trainersData = await getTrainersAtLocation(locationData.id);

        const userIds = trainersData.map(t => t.trainer_profiles.user_id);
        const { data: profiles } = await supabase
          .from('profiles_public')
          .select('user_id, full_name, avatar_url, bio, location, skill_rating, rating_system')
          .in('user_id', userIds);

        const trainerIds = trainersData.map(t => t.trainer_id);
        const { data: reviews } = await supabase
          .from('reviews')
          .select('trainer_id, rating')
          .in('trainer_id', trainerIds)
          .eq('is_public', true);

        const ratingsByTrainer: Record<string, number[]> = {};
        reviews?.forEach(review => {
          if (!ratingsByTrainer[review.trainer_id]) {
            ratingsByTrainer[review.trainer_id] = [];
          }
          ratingsByTrainer[review.trainer_id].push(review.rating);
        });

        const trainersWithProfiles = trainersData
          .map(trainer => ({
            ...trainer,
            profile: profiles?.find(p => p.user_id === trainer.trainer_profiles.user_id),
            avgRating: ratingsByTrainer[trainer.trainer_id]
              ? ratingsByTrainer[trainer.trainer_id].reduce((a, b) => a + b, 0) / ratingsByTrainer[trainer.trainer_id].length
              : undefined,
          }))
          .filter(trainer => trainer.profile?.full_name);

        setTrainers(trainersWithProfiles);

        // Fetch academies at this location
        const academiesData = await getAcademiesAtLocation(locationData.id);
        setAcademies(academiesData);

        // Fetch similar locations from same city (exclude current location)
        const { data: similar } = await supabase
          .from('locations')
          .select('*')
          .eq('city', locationData.city)
          .eq('is_active', true)
          .neq('id', locationData.id)
          .limit(6);

        if (similar && similar.length > 0) {
          setSimilarLocations(similar);
          
          // Fetch trainer counts for similar locations
          const similarIds = similar.map(l => l.id);
          const { data: trainerLocs } = await supabase
            .from('trainer_locations')
            .select('location_id')
            .in('location_id', similarIds);
          
          // Count trainers per location
          const counts: Record<string, number> = {};
          trainerLocs?.forEach(tl => {
            counts[tl.location_id] = (counts[tl.location_id] || 0) + 1;
          });
          setSimilarTrainerCounts(counts);
          
          // Fetch claimed status and logos for similar locations
          const { data: clubProfiles } = await supabase
            .from('club_profiles')
            .select('location_id, logo_url')
            .in('location_id', similarIds);
          
          const claimedSet = new Set<string>();
          const logos: Record<string, string> = {};
          clubProfiles?.forEach(cp => {
            claimedSet.add(cp.location_id);
            if (cp.logo_url) logos[cp.location_id] = cp.logo_url;
          });
          setSimilarClaimedIds(claimedSet);
          setSimilarLogos(logos);
        }
      } catch (error) {
        logger.error('Error fetching location', error instanceof Error ? error : new Error(String(error)), { component: 'LocationDetail' });
      } finally {
        setLoading(false);
      }
    }

    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, user?.id]);

  useEffect(() => {
    if (clubProfile?.id) {
      recordClubProfileView(clubProfile.id);
    }
  }, [clubProfile?.id]);

  const getInitials = (name: string | null | undefined) => {
    if (!name) return 'T';
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

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
    const message = encodeURIComponent(`${location?.name} - ${profileUrl}`);
    window.open(`https://wa.me/?text=${message}`, '_blank');
  };

  const displayDescription = clubProfile?.description || location?.description;
  const displayLogo = clubProfile?.logo_url || location?.logo_url;

  const getStructuredData = () => {
    if (!location) return null;
    return {
      "@context": "https://schema.org",
      "@type": "SportsClub",
      "name": location.name,
      "address": {
        "@type": "PostalAddress",
        "streetAddress": location.street_address,
        "addressLocality": location.city,
        "postalCode": location.postal_code,
        "addressCountry": "NL"
      },
      "url": location.website_url,
      "sport": "Padel",
      ...(location.number_of_courts && { "numberOfRooms": location.number_of_courts }),
      ...(displayDescription && { "description": displayDescription }),
      ...(displayLogo && { "image": displayLogo })
    };
  };

  const getBreadcrumbData = () => {
    if (!location) return null;
    return {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": t('common:navigation.home'), "item": `https://padeltrainer.ai/${currentLang}` },
        { "@type": "ListItem", "position": 2, "name": t('common:locations.title'), "item": `https://padeltrainer.ai/${currentLang}/locations` },
        { "@type": "ListItem", "position": 3, "name": location.name }
      ]
    };
  };

  const citySlug = location?.city?.toLowerCase().replace(/\s+/g, '-');

  // Build social links array
  const socialLinks = [];
  if (clubProfile?.social_instagram) socialLinks.push({ platform: 'instagram' as const, handle: clubProfile.social_instagram });
  if (clubProfile?.social_facebook) socialLinks.push({ platform: 'facebook' as const, handle: clubProfile.social_facebook });
  if (clubProfile?.social_tiktok) socialLinks.push({ platform: 'tiktok' as const, handle: clubProfile.social_tiktok });
  if (clubProfile?.social_youtube) socialLinks.push({ platform: 'youtube' as const, handle: clubProfile.social_youtube });
  if (clubProfile?.social_linkedin) socialLinks.push({ platform: 'linkedin' as const, handle: clubProfile.social_linkedin });

  // Build quick stats - always show indoor/outdoor courts
  const quickStats = [];
  
  // Indoor courts - always show
  quickStats.push({
    icon: <Home className="h-4 w-4" />,
    label: t('common:locations.indoor'),
    value: location?.indoor_courts != null ? location.indoor_courts : '-',
  });
  
  // Outdoor courts - always show
  quickStats.push({
    icon: <Sun className="h-4 w-4" />,
    label: t('common:locations.outdoor'),
    value: location?.outdoor_courts != null ? location.outdoor_courts : '-',
  });
  
  // Trainers - always show
  quickStats.push({
    icon: <Users className="h-4 w-4" />,
    label: trainers.length === 1 ? t('common:locations.trainer') : t('common:locations.trainers'),
    value: trainers.length,
  });
  
  // Member since - only if claimed
  if (clubProfile?.claimed_at) {
    quickStats.push({
      icon: <Calendar className="h-4 w-4" />,
      label: t('common:locations.memberSince'),
      value: format(new Date(clubProfile.claimed_at), 'MMM yyyy', { locale: dateLocale }),
    });
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!location) {
    return null;
  }

  const seoDescription = displayDescription
    ? displayDescription.slice(0, 155)
    : t('marketing:seo.location.description', { name: location.name, city: location.city, count: trainers.length });

  const breadcrumbs = [
    { label: t('common:navigation.home'), path: '/' },
    { label: t('common:locations.title'), path: '/locations' },
    { label: location.name },
  ];

  const allStructuredData = [getStructuredData(), getBreadcrumbData()].filter(Boolean);

  return (
    <>
      <SEO
        title={t('marketing:seo.location.title', { name: location.name, city: location.city })}
        description={seoDescription}
        url={`/locations/${location.slug}`}
        type="place"
        image={displayLogo || clubProfile?.banner_url || 'https://padeltrainer.ai/og-locations.png'}
        structuredData={allStructuredData.length > 0 ? allStructuredData : undefined}
      />

    <ProfileLayout
      breadcrumbs={breadcrumbs}
      bannerUrl={clubProfile?.banner_url}
      showBackButton={false}
      headerAction={
          !user ? (
            <Button onClick={() => navigate(localizePath('/auth'))}>{t('common:signIn')}</Button>
          ) : null
        }
      >
        {/* Hero Card */}
        <ProfileHeroCard
          name={location.name}
          avatarUrl={displayLogo}
          location={`${location.street_address ? location.street_address + ', ' : ''}${location.postal_code || ''} ${location.city}`}
          isVerified={isClaimed}
          socialLinks={socialLinks}
          statsSlot={
            location.number_of_courts ? (
              <span className="text-muted-foreground flex items-center gap-1">
                <LayoutGrid className="h-4 w-4" />
                {location.number_of_courts} {location.number_of_courts === 1 ? t('common:locations.court') : t('common:locations.courts')}
              </span>
            ) : null
          }
        >
          {/* Action Buttons */}
          {location.website_url && (
            <Button
              variant="outline"
              size="lg"
              className="w-full"
              onClick={() => {
                const url = new URL(location.website_url!);
                url.searchParams.set('ref', 'padeltrainerai');
                window.open(url.toString(), '_blank');
              }}
            >
              <ExternalLink className="h-4 w-4 mr-2" />
              {t('common:locations.visitWebsite')}
            </Button>
          )}
          <Button
            variant="outline"
            size="lg"
            className="w-full"
            onClick={() => window.open(`https://maps.google.com/?q=${encodeURIComponent(`${location.street_address || ''} ${location.postal_code} ${location.city}`)}`, '_blank')}
          >
            <MapPin className="h-4 w-4 mr-2" />
            {t('common:locations.getDirections')}
          </Button>
          {clubProfile && (
            <ClubFollowButton clubProfileId={clubProfile.id} />
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="lg" className="w-full">
                {copied ? (
                  <>
                    <Check className="h-4 w-4 mr-2" />
                    {t('common:copied', 'Copied!')}
                  </>
                ) : (
                  <>
                    <Share2 className="h-4 w-4 mr-2" />
                    {t('common:share', 'Share')}
                  </>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={handleCopyLink}>
                <Copy className="h-4 w-4 mr-2" />
                {t('common:copyLink', 'Copy Link')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleShareWhatsApp}>
                <MessageCircle className="h-4 w-4 mr-2" />
                WhatsApp
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {!isClaimed && (
            <Button
              variant="default"
              size="lg"
              className="w-full"
              onClick={() => {
                if (!user) {
                  navigate(localizePath('/auth'));
                  return;
                }
                setShowClaimDialog(true);
              }}
            >
              <Building2 className="h-4 w-4 mr-2" />
              {t('club:claim.button')}
            </Button>
          )}
          {isManager && (
            <Button
              variant="secondary"
              size="lg"
              className="w-full"
              onClick={() => navigate('/club/settings')}
            >
              <Settings className="h-4 w-4 mr-2" />
              {t('common:locations.editClub')}
            </Button>
          )}
        </ProfileHeroCard>

        {/* Content Grid */}
        <ProfileContentGrid>
          {/* Main Content */}
          <ProfileMainColumn>
            {/* About Club Card */}
            <Card>
              <CardHeader>
                <CardTitle>{t('common:locations.aboutClub')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {displayDescription ? (
                  <p className="text-muted-foreground whitespace-pre-wrap">{displayDescription}</p>
                ) : (
                  <p className="text-muted-foreground italic">{t('common:locations.noDescription')}</p>
                )}

                {!isClaimed && (
                  <div className="border-t pt-4">
                    <div className="flex items-start gap-3">
                      <Building2 className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
                      <div className="space-y-2">
                        <p className="text-sm text-muted-foreground">
                          {t('club:claim.aboutSectionNote', 'This club hasn\'t been claimed yet. Are you the owner or manager?')}
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            if (!user) {
                              navigate(localizePath('/auth'));
                              return;
                            }
                            setShowClaimDialog(true);
                          }}
                        >
                          <Building2 className="h-4 w-4 mr-1" />
                          {t('club:claim.button')}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Open Cycles for Registration - from trainers and academies at this location */}
            <LocationOpenCycles
              locationId={location.id}
              locationName={location.name}
              clubSlug={clubProfile?.id}
            />

            {/* Waiting List Card */}
            <WaitingListCard
              ownerType="location"
              ownerId={location.id}
              ownerName={location.name}
            />

            {/* Upcoming Tournaments */}
            {clubProfile && (
              <UpcomingTournaments clubProfileId={clubProfile.id} />
            )}
          </ProfileMainColumn>

          {/* Sidebar */}
          <ProfileSidebarColumn>
            <ProfileQuickStatsCard
              title={t('common:locations.quickStats')}
              stats={quickStats}
            />
            
            {/* Academy Card in Sidebar */}
            {academies.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <GraduationCap className="h-4 w-4" />
                    {academies.length === 1 ? t('common:academy', 'Academy') : t('common:academies')}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {academies.map(academy => (
                    <div
                      key={academy.id}
                      className="flex items-center gap-3 cursor-pointer hover:bg-muted/50 rounded-lg p-2 -mx-2 transition-colors"
                      onClick={() => navigate(localizePath(`/academies/${academy.slug}`))}
                    >
                      <Avatar className="h-10 w-10 rounded-lg bg-muted">
<AvatarImage src={academy.logo_url || ''} className="object-cover" alt={academy.name} />
                        <AvatarFallback className="rounded-lg">{getInitials(academy.name)}</AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-sm truncate">{academy.name}</span>
                          {academy.is_verified && (
                            <CheckCircle className="h-3.5 w-3.5 text-primary flex-shrink-0" />
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* City Trainers Cross-Link */}
            {citySlug && (
              <Card>
                <CardContent className="p-4">
                  <LocalizedLink 
                    to={`/trainers/${citySlug}`}
                    className="flex items-center gap-2 text-primary hover:underline font-medium"
                  >
                    <Users className="h-4 w-4" />
                    {t('common:findMoreTrainersIn', { city: location.city, defaultValue: `Find more trainers in ${location.city}` })} →
                  </LocalizedLink>
                </CardContent>
              </Card>
            )}

            {/* Sponsor Banner - Sidebar */}
            {!clubProfile?.subscription_tier || clubProfile.subscription_tier === 'starter' ? (
              <SponsorBanner placementSlug="location-detail-sidebar" locationId={location?.id} />
            ) : null}
          </ProfileSidebarColumn>
        </ProfileContentGrid>

        {/* Full Width - Trainers Section */}
        <ProfileFullWidthSection>
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-xl flex items-center gap-2">
                  <Users className="h-5 w-5 text-primary" />
                  {t('common:locations.trainersAtLocation')}
                </CardTitle>
                <Badge variant="secondary" className="text-sm">
                  {trainers.length} {trainers.length === 1 ? t('common:locations.trainer') : t('common:locations.trainers')}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              {trainers.length === 0 ? (
                <div className="py-8 text-center">
                  <Users className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                  <h3 className="text-lg font-medium mb-2">{t('common:locations.noTrainers')}</h3>
                  <p className="text-muted-foreground">
                    {t('common:locations.noTrainersDescription')}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {trainers.map(trainer => (
                    <Card
                      key={trainer.id}
                      className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
                      onClick={() => navigate(localizePath(`/trainer/${trainer.trainer_profiles.slug || trainer.trainer_profiles.id}`))}
                    >
                      <CardHeader className="pb-2">
                        <div className="flex items-start gap-4">
                          <Avatar className="h-14 w-14">
                            <AvatarImage src={trainer.profile?.avatar_url || ''} alt={trainer.profile?.full_name || ''} />
                            <AvatarFallback>{getInitials(trainer.profile?.full_name)}</AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <CardTitle className="text-lg truncate">
                                {trainer.profile?.full_name || 'Trainer'}
                              </CardTitle>
                              {trainer.trainer_profiles.is_verified && (
                                <Badge variant="secondary" className="shrink-0">
                                  {t('common:verified')}
                                </Badge>
                              )}
                            </div>
                            {trainer.avgRating && (
                              <div className="flex items-center gap-1 text-sm">
                                <Star className="h-4 w-4 text-yellow-500 fill-yellow-500" />
                                <span>{trainer.avgRating.toFixed(1)}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <div className="flex items-center justify-between text-sm">
                          {trainer.trainer_profiles.hourly_rate && (
                            <span className="font-semibold text-primary">
                              €{trainer.trainer_profiles.hourly_rate}{t('common:perHour')}
                            </span>
                          )}
                          {trainer.trainer_profiles.experience_years && (
                            <span className="text-muted-foreground">
                              {t('common:yearsExperience', { count: trainer.trainer_profiles.experience_years })}
                            </span>
                          )}
                        </div>

                        {trainer.trainer_profiles.specializations && trainer.trainer_profiles.specializations.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {trainer.trainer_profiles.specializations.slice(0, 3).map(spec => (
                              <Badge key={spec} variant="outline" className="text-xs">
                                {spec}
                              </Badge>
                            ))}
                            {trainer.trainer_profiles.specializations.length > 3 && (
                              <Badge variant="outline" className="text-xs">
                                +{trainer.trainer_profiles.specializations.length - 3}
                              </Badge>
                            )}
                          </div>
                        )}

                        {trainer.is_primary && (
                          <Badge variant="default" className="text-xs">
                            {t('common:locations.primaryLocation')}
                          </Badge>
                        )}

                        <div className="flex gap-2 pt-2" onClick={e => e.stopPropagation()}>
                          <Button
                            variant="default"
                            size="sm"
                            className="flex-1"
                            onClick={() => navigate(localizePath(`/trainer/${trainer.trainer_profiles.slug || trainer.trainer_profiles.id}`))}
                          >
                            {t('common:viewProfile')}
                          </Button>
                          <FollowButton trainerProfileId={trainer.trainer_id} size="sm" />
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </ProfileFullWidthSection>

        {/* Full Width - Academies Section */}
        {academies.length > 0 && (
          <ProfileFullWidthSection>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-semibold flex items-center gap-2">
                <GraduationCap className="h-6 w-6 text-primary" />
                {t('common:locations.academiesAtLocation', 'Training Academies')}
              </h2>
              <Badge variant="secondary" className="text-sm">
                {academies.length} {academies.length === 1 ? t('common:academy', 'Academy') : t('common:academies')}
              </Badge>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {academies.map(academy => (
                <Card
                  key={academy.id}
                  className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
                  onClick={() => navigate(localizePath(`/academies/${academy.slug}`))}
                >
                  <CardContent className="pt-6">
                    <div className="flex items-start gap-4">
                      <Avatar className="h-14 w-14 rounded-lg bg-muted">
                        <AvatarImage src={academy.logo_url || ''} className="object-cover" alt={academy.name} />
                        <AvatarFallback className="rounded-lg">{getInitials(academy.name)}</AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold truncate">{academy.name}</h3>
                          {academy.is_verified && (
                            <CheckCircle className="h-4 w-4 text-primary flex-shrink-0" />
                          )}
                        </div>
                        {academy.description && (
                          <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
                            {academy.description}
                          </p>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </ProfileFullWidthSection>
        )}

        {/* Full Width - Similar Clubs Section */}
        {similarLocations.length > 0 && (
          <ProfileFullWidthSection>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-semibold flex items-center gap-2">
                <Building2 className="h-6 w-6 text-primary" />
                {t('common:locations.similarClubs', { city: location.city })}
              </h2>
              <Badge variant="secondary" className="text-sm">
                {similarLocations.length} {similarLocations.length === 1 ? t('common:locations.club', 'Club') : t('common:locations.clubs', 'Clubs')}
              </Badge>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {similarLocations.map(loc => (
                <LocationCard 
                  key={loc.id} 
                  location={loc} 
                  trainerCount={similarTrainerCounts[loc.id] || 0}
                  isClaimed={similarClaimedIds.has(loc.id)}
                  logoUrl={similarLogos[loc.id]}
                />
              ))}
            </div>
          </ProfileFullWidthSection>
        )}

        {location && user && (
          <ClaimClubDialog
            open={showClaimDialog}
            onOpenChange={setShowClaimDialog}
            locationId={location.id}
            locationName={location.name}
            userId={user.id}
            userEmail={user.email}
          />
        )}
      </ProfileLayout>
    </>
  );
}
