import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { MapPin, ExternalLink, Loader2, Star, Users, Building2, CheckCircle, LayoutGrid, Calendar, Settings, Instagram, Facebook, Youtube, Linkedin } from 'lucide-react';
import { ClubOpenCycles } from '@/components/club/ClubOpenCycles';
import { UpcomingTournaments } from '@/components/club/UpcomingTournaments';
import { LocalizedLink } from '@/components/LocalizedLink';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { FollowButton } from '@/components/trainers/FollowButton';
import { getLocationBySlug, getTrainersAtLocation, getClubProfileByLocationId, type Location } from '@/lib/locations';
import { isLocationClaimed, isUserClubManager } from '@/lib/club';
import { recordClubProfileView } from '@/lib/clubProfileViews';
import { ClaimClubDialog } from '@/components/club/ClaimClubDialog';
import { supabase } from '@/integrations/supabase/client';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { format } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';

interface TrainerWithProfile {
  id: string;
  is_primary: boolean;
  trainer_id: string;
  trainer_profiles: {
    id: string;
    user_id: string;
    hourly_rate: number | null;
    experience_years: number | null;
    specializations: string[] | null;
    certifications: string[] | null;
    is_verified: boolean | null;
    knltb_rating: number | null;
  };
  profile?: {
    full_name: string | null;
    avatar_url: string | null;
    bio: string | null;
    location: string | null;
  };
  avgRating?: number;
}

// Public-safe club profile (excludes contact details like email/phone)
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
  const [location, setLocation] = useState<Location | null>(null);
  const [clubProfile, setClubProfile] = useState<ClubProfile | null>(null);
  const [trainers, setTrainers] = useState<TrainerWithProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [isClaimed, setIsClaimed] = useState(false);
  const [isManager, setIsManager] = useState(false);
  const [showClaimDialog, setShowClaimDialog] = useState(false);

  const dateLocale = i18n.language === 'nl' ? nl : enUS;

  useEffect(() => {
    async function fetchData() {
      if (!slug) return;

      try {
        const locationData = await getLocationBySlug(slug);
        if (!locationData) {
          navigate(localizePath('/locations'));
          return;
        }
        
        // Check if location is claimed and fetch club profile
        const [claimed, clubProfileData] = await Promise.all([
          isLocationClaimed(locationData.id),
          getClubProfileByLocationId(locationData.id),
        ]);
        setIsClaimed(claimed);
        setClubProfile(clubProfileData as ClubProfile | null);
        setLocation(locationData);

        // Check if current user is a manager
        if (user && clubProfileData) {
          const managerStatus = await isUserClubManager(user.id);
          setIsManager(managerStatus);
        }

        const trainersData = await getTrainersAtLocation(locationData.id);
        
        // Fetch profiles for trainers
        const userIds = trainersData.map(t => t.trainer_profiles.user_id);
        const { data: profiles } = await supabase
          .from('profiles_public')
          .select('user_id, full_name, avatar_url, bio, location')
          .in('user_id', userIds);

        // Fetch average ratings
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

        const trainersWithProfiles = trainersData.map(trainer => ({
          ...trainer,
          profile: profiles?.find(p => p.user_id === trainer.trainer_profiles.user_id),
          avgRating: ratingsByTrainer[trainer.trainer_id]
            ? ratingsByTrainer[trainer.trainer_id].reduce((a, b) => a + b, 0) / ratingsByTrainer[trainer.trainer_id].length
            : undefined,
        }));

        setTrainers(trainersWithProfiles);
      } catch (error) {
        console.error('Error fetching location:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [slug, navigate, user, localizePath]);

  // Record profile view when club profile is loaded
  useEffect(() => {
    if (clubProfile?.id) {
      recordClubProfileView(clubProfile.id);
    }
  }, [clubProfile?.id]);

  const getInitials = (name: string | null | undefined) => {
    if (!name) return 'T';
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  // Use club profile data if available, otherwise fall back to location data
  const displayDescription = clubProfile?.description || location?.description;
  const displayLogo = clubProfile?.logo_url || location?.logo_url;

  // Generate structured data for SEO
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

  if (loading) {
    return (
      <MarketingLayout>
        <div className="flex items-center justify-center min-h-[60vh]">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </MarketingLayout>
    );
  }

  if (!location) {
    return null;
  }

  const seoDescription = displayDescription 
    ? displayDescription.slice(0, 155) 
    : `Book padel lessons at ${location.name} in ${location.city}. ${trainers.length} certified trainers available.`;

  return (
    <MarketingLayout>
      <SEO
        title={`${location.name} - Padel Training in ${location.city}`}
        description={seoDescription}
        url={`/locations/${location.slug}`}
        type="place"
        image={displayLogo || undefined}
        structuredData={getStructuredData() || undefined}
      />
      <div className="min-h-screen bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10">
        {/* Banner */}
        {clubProfile?.banner_url && (
          <div className="w-full h-48 md:h-64 overflow-hidden">
            <img 
              src={clubProfile.banner_url} 
              alt={`${location.name} banner`}
              className="w-full h-full object-cover"
            />
          </div>
        )}

        {/* Header */}
        <div className="bg-gradient-to-r from-primary/10 to-primary/5 border-b">
          <div className="container mx-auto px-4 py-8">
            {/* Breadcrumb */}
            <Breadcrumb className="mb-4">
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <LocalizedLink to="/">{t('navigation.home')}</LocalizedLink>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <LocalizedLink to="/locations">{t('locations.title')}</LocalizedLink>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>{location.name}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>

            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
              <div>
                <div className="flex items-center gap-3 mb-2">
                  <h1 className="text-3xl font-bold">{location.name}</h1>
                  {isClaimed && (
                    <Badge variant="default" className="flex items-center gap-1">
                      <CheckCircle className="h-3 w-3" />
                      {t('locations.verified')}
                    </Badge>
                  )}
                </div>
                <div className="flex items-start gap-2 text-muted-foreground">
                  <MapPin className="h-5 w-5 mt-0.5 shrink-0" />
                  <div>
                    {location.street_address && <span>{location.street_address}, </span>}
                    <span>{location.postal_code} {location.city}</span>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {location.website_url && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      const url = new URL(location.website_url!);
                      url.searchParams.set('ref', 'padeltrainerai');
                      window.open(url.toString(), '_blank');
                    }}
                  >
                    <ExternalLink className="h-4 w-4 mr-2" />
                    {t('locations.visitWebsite')}
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={() => window.open(`https://maps.google.com/?q=${encodeURIComponent(`${location.street_address || ''} ${location.postal_code} ${location.city}`)}`, '_blank')}
                >
                  <MapPin className="h-4 w-4 mr-2" />
                  {t('locations.getDirections')}
                </Button>
                
                {/* Social Media Icons */}
                {clubProfile?.social_instagram && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      const handle = clubProfile.social_instagram!;
                      const url = handle.startsWith('http') ? handle : `https://instagram.com/${handle.replace('@', '')}`;
                      window.open(url, '_blank');
                    }}
                    aria-label="Instagram"
                  >
                    <Instagram className="h-5 w-5" />
                  </Button>
                )}
                {clubProfile?.social_facebook && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      const handle = clubProfile.social_facebook!;
                      const url = handle.startsWith('http') ? handle : `https://facebook.com/${handle}`;
                      window.open(url, '_blank');
                    }}
                    aria-label="Facebook"
                  >
                    <Facebook className="h-5 w-5" />
                  </Button>
                )}
                {clubProfile?.social_tiktok && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      const handle = clubProfile.social_tiktok!;
                      const url = handle.startsWith('http') ? handle : `https://tiktok.com/${handle.startsWith('@') ? handle : '@' + handle}`;
                      window.open(url, '_blank');
                    }}
                    aria-label="TikTok"
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
                      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z"/>
                    </svg>
                  </Button>
                )}
                {clubProfile?.social_youtube && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      const handle = clubProfile.social_youtube!;
                      const url = handle.startsWith('http') ? handle : `https://youtube.com/${handle.startsWith('@') ? handle : '@' + handle}`;
                      window.open(url, '_blank');
                    }}
                    aria-label="YouTube"
                  >
                    <Youtube className="h-5 w-5" />
                  </Button>
                )}
                {clubProfile?.social_linkedin && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      const handle = clubProfile.social_linkedin!;
                      const url = handle.startsWith('http') ? handle : `https://linkedin.com/${handle}`;
                      window.open(url, '_blank');
                    }}
                    aria-label="LinkedIn"
                  >
                    <Linkedin className="h-5 w-5" />
                  </Button>
                )}
                
                {!isClaimed && (
                  <Button
                    variant="default"
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
                    onClick={() => navigate('/club/settings')}
                  >
                    <Settings className="h-4 w-4 mr-2" />
                    {t('locations.editClub')}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="container mx-auto px-4 py-8 space-y-8">
          {/* Quick Stats & About */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Quick Stats Card */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-lg">{t('locations.quickStats')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {location.number_of_courts != null && location.number_of_courts > 0 && (
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-primary/10 rounded-lg">
                      <LayoutGrid className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <div className="font-semibold">{location.number_of_courts}</div>
                      <div className="text-sm text-muted-foreground">
                        {location.number_of_courts === 1 ? t('locations.court') : t('locations.courts')}
                      </div>
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-primary/10 rounded-lg">
                    <Users className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <div className="font-semibold">{trainers.length}</div>
                    <div className="text-sm text-muted-foreground">
                      {trainers.length === 1 ? t('locations.trainer') : t('locations.trainers')}
                    </div>
                  </div>
                </div>
                {clubProfile?.claimed_at && (
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-primary/10 rounded-lg">
                      <Calendar className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <div className="font-semibold">
                        {format(new Date(clubProfile.claimed_at), 'MMM yyyy', { locale: dateLocale })}
                      </div>
                      <div className="text-sm text-muted-foreground">{t('locations.memberSince')}</div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* About Club Card */}
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg">{t('locations.aboutClub')}</CardTitle>
              </CardHeader>
              <CardContent>
                {displayDescription ? (
                  <p className="text-muted-foreground whitespace-pre-wrap">{displayDescription}</p>
                ) : (
                  <p className="text-muted-foreground italic">{t('locations.noDescription')}</p>
                )}
              </CardContent>
            </Card>
          </div>

          <Separator />

          {/* Open Cycles for Registration */}
          {clubProfile && (
            <ClubOpenCycles 
              clubProfileId={clubProfile.id} 
              clubName={location.name} 
            />
          )}

          {/* Upcoming Tournaments */}
          {clubProfile && (
            <UpcomingTournaments clubProfileId={clubProfile.id} />
          )}

          <Separator />
          {/* Claim Dialog */}
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

          {/* Trainers */}
          <div>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-semibold flex items-center gap-2">
                <Users className="h-6 w-6 text-primary" />
                {t('locations.trainersAtLocation')}
              </h2>
              <Badge variant="secondary" className="text-sm">
                {trainers.length} {trainers.length === 1 ? t('locations.trainer') : t('locations.trainers')}
              </Badge>
            </div>

            {trainers.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <Users className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                  <h3 className="text-lg font-medium mb-2">{t('locations.noTrainers')}</h3>
                  <p className="text-muted-foreground">
                    {t('locations.noTrainersDescription')}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {trainers.map(trainer => (
                  <Card
                    key={trainer.id}
                    className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
                    onClick={() => navigate(localizePath(`/trainer/${trainer.trainer_profiles.user_id}`))}
                  >
                    <CardHeader className="pb-2">
                      <div className="flex items-start gap-4">
                        <Avatar className="h-14 w-14">
                          <AvatarImage src={trainer.profile?.avatar_url || ''} />
                          <AvatarFallback>{getInitials(trainer.profile?.full_name)}</AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <CardTitle className="text-lg truncate">
                              {trainer.profile?.full_name || 'Trainer'}
                            </CardTitle>
                            {trainer.trainer_profiles.is_verified && (
                              <Badge variant="secondary" className="shrink-0">
                                {t('verified')}
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
                            €{trainer.trainer_profiles.hourly_rate}{t('perHour')}
                          </span>
                        )}
                        {trainer.trainer_profiles.experience_years && (
                          <span className="text-muted-foreground">
                            {t('yearsExperience', { count: trainer.trainer_profiles.experience_years })}
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
                          {t('locations.primaryLocation')}
                        </Badge>
                      )}

                      <div className="flex gap-2 pt-2" onClick={e => e.stopPropagation()}>
                        <Button
                          variant="default"
                          size="sm"
                          className="flex-1"
                          onClick={() => navigate(`/book/${trainer.trainer_id}`)}
                        >
                          {t('locations.bookLesson')}
                        </Button>
                        <FollowButton trainerProfileId={trainer.trainer_id} size="sm" />
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </MarketingLayout>
  );
}
