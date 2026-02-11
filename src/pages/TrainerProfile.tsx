import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { LocalizedLink } from '@/components/LocalizedLink';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/hooks/useAuth';
import { useFollowTrainer } from '@/hooks/useFollowTrainer';
import { useLocalizedPathFn, useCurrentLanguage } from '@/hooks/useLocalizedPath';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { 
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { 
  ArrowLeft, MapPin, Star, Clock, Award, Mail, Euro,
  Calendar, Users, CheckCircle, UserPlus, UserCheck,
  Share2, Copy, Check, MessageCircle, Quote, Play,
  Target, Sparkles, Linkedin, GraduationCap, Eye, EyeOff,
  Building2, TreePine
} from 'lucide-react';
import { TrainerReviews } from '@/components/reviews/TrainerReviews';
import { TrainerOpenCycles } from '@/components/trainer/TrainerOpenCycles';
import { TrainerOpenSlots } from '@/components/trainer/TrainerOpenSlots';
import { WaitingListCard } from '@/components/waitingList';
import { getTrainerAverageRating } from '@/lib/reviews';
import { recordProfileView } from '@/lib/profileViews';
import { parseVideoUrl } from '@/lib/videoEmbed';
import { getRatingSystemByCode } from '@/lib/ratingSystems';
import { getTrainerAcademy, isTrainerInPaidAcademy, type AcademyProfile } from '@/lib/academy';
import { toast } from 'sonner';
import { getMarketingUrl, getAppUrl } from '@/lib/domains';
import { SEO } from '@/components/SEO';
import { logger } from '@/lib/logger';
import { trackEvent } from '@/lib/tracking';
import {
  ProfileLayout,
  ProfileContentGrid,
  ProfileMainColumn,
  ProfileSidebarColumn,
  ProfileHeroCard,
  ProfileQuickStatsCard,
  ProfileContactCard,
  ProfileSocialCard,
  VideoGallery,
} from '@/components/profiles';

interface TrainerData {
  id: string;
  user_id: string;
  slug: string | null;
  hourly_rate: number | null;
  experience_years: number | null;
  certifications: string[] | null;
  specializations: string[] | null;
  is_verified: boolean;
  is_public: boolean;
  subscription_status: string | null;
  trial_ends_at: string | null;
  coaching_method: string | null;
  favourite_quote: string | null;
  video_url: string | null;
  website_url: string | null;
  social_instagram: string | null;
  social_tiktok: string | null;
  social_youtube: string | null;
  social_linkedin: string | null;
  preferred_min_rating: number | null;
  preferred_max_rating: number | null;
  preferred_rating_system: string | null;
}

interface ProfileData {
  full_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  location: string | null;
}

// LessonData removed - lessons table no longer exists

interface TrainerLocationData {
  id: string;
  is_primary: boolean;
  relationship_type: string;
  location: {
    id: string;
    name: string;
    city: string;
    slug: string;
    indoor_courts: number | null;
    outdoor_courts: number | null;
  };
  club?: {
    id: string;
    is_verified: boolean;
    location_id: string;
  } | null;
}

export default function TrainerProfile() {
  const { trainerId } = useParams<{ trainerId: string }>();
  const { t } = useTranslation(['trainer', 'common']);
  const [trainer, setTrainer] = useState<TrainerData | null>(null);
  const [profile, setProfile] = useState<ProfileData | null>(null);
  
  const [trainerLocations, setTrainerLocations] = useState<TrainerLocationData[]>([]);
  const [trainerAcademy, setTrainerAcademy] = useState<Partial<AcademyProfile> | null>(null);
  const [loading, setLoading] = useState(true);
  const [averageRating, setAverageRating] = useState<number | null>(null);
  const [reviewCount, setReviewCount] = useState(0);
  const [copied, setCopied] = useState(false);
  const [showVideo, setShowVideo] = useState(false);
  const [preferredRatingSystemName, setPreferredRatingSystemName] = useState<string>('');
  const navigate = useNavigate();
  const { user, role } = useAuth();
  const { isFollowing, loading: followLoading, toggleFollow, canFollow } = useFollowTrainer(trainer?.id || null);
  const localizePath = useLocalizedPathFn();
  const currentLang = useCurrentLanguage();

  // Use slug for URLs if available, else fallback to trainerId from params
  const trainerSlug = trainer?.slug || trainerId;
  const profileUrl = getMarketingUrl(`trainer/${trainerSlug}`, currentLang);
  const trainerName = profile?.full_name || 'Trainer';

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(profileUrl);
      setCopied(true);
      toast.success(t('profile.linkCopied'));
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      toast.error('Failed to copy link');
    }
  };

  const handleShareWhatsApp = () => {
    const message = encodeURIComponent(`${t('profile.shareMessage', { name: trainerName })} ${profileUrl}`);
    window.open(`https://wa.me/?text=${message}`, '_blank');
  };

  const handleShareTwitter = () => {
    const text = encodeURIComponent(t('profile.shareMessage', { name: trainerName }));
    window.open(`https://twitter.com/intent/tweet?text=${text}&url=${encodeURIComponent(profileUrl)}`, '_blank');
  };

  const handleShareLinkedIn = () => {
    window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(profileUrl)}`, '_blank');
  };

  useEffect(() => {
    if (trainerId) {
      fetchTrainerProfile();
    }
  }, [trainerId]);

  useEffect(() => {
    if (trainer?.id) {
      recordProfileView(trainer.id);
      trackEvent('trainer_profile_viewed', {
        trainer_id: trainer.id,
        trainer_slug: trainer.slug,
      });
    }
  }, [trainer?.id]);

  useEffect(() => {
    if (trainer?.preferred_rating_system) {
      getRatingSystemByCode(trainer.preferred_rating_system).then(system => {
        if (system) setPreferredRatingSystemName(system.name);
      });
    }
  }, [trainer?.preferred_rating_system]);

  const fetchTrainerProfile = async () => {
    setLoading(true);
    
    // Fetch trainer profile by slug (preferred) or ID (fallback for legacy URLs)
    const isUUID = trainerId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trainerId);
    
    let trainerResult;
    if (isUUID) {
      // Legacy UUID-based URL
      trainerResult = await supabase
        .from('trainer_profiles_safe')
        .select('*')
        .eq('id', trainerId)
        .maybeSingle();
    } else {
      // SEO-friendly slug URL
      trainerResult = await supabase
        .from('trainer_profiles_safe')
        .select('*')
        .eq('slug', trainerId)
        .maybeSingle();
    }

    if (trainerResult.error || !trainerResult.data) {
      logger.error('Error fetching trainer', undefined, { supabaseError: trainerResult.error });
      setLoading(false);
      return;
    }

    // Then fetch the user profile using the trainer's user_id
    const profileResult = await supabase
      .from('profiles_public')
      .select('full_name, avatar_url, bio, location')
      .eq('user_id', trainerResult.data.user_id)
      .maybeSingle();

    if (trainerResult.error) {
      logger.error('Error fetching trainer', undefined, { supabaseError: trainerResult.error });
      setLoading(false);
      return;
    }

    const { data: clubLink } = await supabase
      .from('trainer_locations')
      .select(`
        id,
        show_on_club_page,
        location:locations!inner(
          id,
          club_profiles:club_profiles!inner(id, is_verified)
        )
      `)
      .eq('trainer_id', trainerResult.data.id)
      .eq('relationship_type', 'club_trainer');
    
    const hasVerifiedClubLink = clubLink?.some(
      (link: any) => link.show_on_club_page && link.location?.club_profiles?.is_verified
    );

    // Allow the trainer to view their own profile even if not public
    const isOwnProfile = user?.id === trainerResult.data.user_id;

    // Check subscription-based visibility: must have active subscription, trial, or paid academy
    const now = new Date().toISOString();
    const hasActiveSubscription = trainerResult.data.subscription_status === 'active';
    const hasActiveTrial = trainerResult.data.trial_ends_at && trainerResult.data.trial_ends_at > now;
    const inPaidAcademy = await isTrainerInPaidAcademy(trainerResult.data.id);
    const hasSubscriptionAccess = hasActiveSubscription || inPaidAcademy;

    if (!trainerResult.data.is_public && !hasVerifiedClubLink && !isOwnProfile) {
      logger.debug('Trainer is not public and not linked to verified club');
      setLoading(false);
      return;
    }

    if (!hasSubscriptionAccess && !isOwnProfile) {
      logger.debug('Trainer has no active subscription, trial, or paid academy membership');
      setLoading(false);
      return;
    }
    
    setTrainer(trainerResult.data);
    
    const [ratingRes, locationsResult] = await Promise.all([
      getTrainerAverageRating(trainerResult.data.id),
      supabase
        .from('trainer_locations')
        .select(`
          id,
          is_primary,
          relationship_type,
          location:locations(id, name, city, slug, indoor_courts, outdoor_courts)
        `)
        .eq('trainer_id', trainerResult.data.id)
    ]);

    setAverageRating(ratingRes.average);
    setReviewCount(ratingRes.count);
    
    if (locationsResult.data) {
      const locationIds = locationsResult.data
        .map(l => (l.location as any)?.id)
        .filter(Boolean);
      
      let clubsMap: Record<string, any> = {};
      if (locationIds.length > 0) {
        const { data: clubs } = await supabase
          .from('club_profiles')
          .select('id, location_id, is_verified')
          .in('location_id', locationIds)
          .eq('is_verified', true);
        
        if (clubs) {
          clubs.forEach(club => {
            clubsMap[club.location_id] = club;
          });
        }
      }
      
      setTrainerLocations(locationsResult.data.map(loc => ({
        ...loc,
        location: loc.location as any,
        club: clubsMap[(loc.location as any)?.id] || null
      })));
    }

    // Fetch academy affiliation
    const academyData = await getTrainerAcademy(trainerResult.data.id);
    setTrainerAcademy(academyData);

    if (profileResult.error) {
      logger.error('Error fetching profile', undefined, { supabaseError: profileResult.error });
    } else {
      setProfile(profileResult.data);
    }

    setLoading(false);
  };

  const videoInfo = trainer?.video_url ? parseVideoUrl(trainer.video_url) : null;

  // Build social links
  const socialLinks = [];
  if (trainer?.social_instagram) socialLinks.push({ platform: 'instagram' as const, handle: trainer.social_instagram });
  if (trainer?.social_tiktok) socialLinks.push({ platform: 'tiktok' as const, handle: trainer.social_tiktok });
  if (trainer?.social_youtube) socialLinks.push({ platform: 'youtube' as const, handle: trainer.social_youtube });
  if (trainer?.social_linkedin) socialLinks.push({ platform: 'linkedin' as const, handle: trainer.social_linkedin });

  // Build quick stats
  const quickStats = [
    { icon: <Euro className="h-4 w-4" />, label: t('common:hourlyRate', 'Hourly Rate'), value: trainer?.hourly_rate ? `€${trainer.hourly_rate}` : '—' },
    { icon: <Calendar className="h-4 w-4" />, label: t('common:experience', 'Experience'), value: trainer?.experience_years ? `${trainer.experience_years} ${t('common:years', 'years')}` : '—' },
    { icon: <CheckCircle className="h-4 w-4" />, label: t('common:verified', 'Verified'), value: trainer?.is_verified ? t('common:yes', 'Yes') : t('common:no', 'No') },
    { icon: <Star className="h-4 w-4" />, label: t('common:rating', 'Rating'), value: averageRating !== null ? `${averageRating} ★` : '—' },
  ];

  if (trainer && trainer.preferred_min_rating !== null && trainer.preferred_max_rating !== null) {
    quickStats.push({
      icon: <Target className="h-4 w-4" />,
      label: t('trainer:profile.preferredLevels', 'Preferred Levels'),
      value: `${trainer.preferred_min_rating}-${trainer.preferred_max_rating}`,
    });
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!trainer || !profile) {
    return (
      <ProfileLayout
        headerAction={
          <Button onClick={() => navigate(localizePath('/trainers'))}>{t('common:browseTrainers', 'Browse Trainers')}</Button>
        }
      >
        <div className="text-center py-12">
          <h1 className="text-2xl font-bold mb-2">{t('common:trainerNotFound', 'Trainer Not Found')}</h1>
          <p className="text-muted-foreground mb-4">{t('common:trainerNotFoundDescription', "This trainer profile doesn't exist or has been removed.")}</p>
          <Button onClick={() => navigate(localizePath('/trainers'))}>{t('common:browseTrainers', 'Browse Trainers')}</Button>
        </div>
      </ProfileLayout>
    );
  }

  // Get primary city for cross-linking
  const trainerCity = profile?.location || trainerLocations[0]?.location?.city;
  const trainerCitySlug = trainerCity?.toLowerCase().replace(/\s+/g, '-');

  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Person",
    "name": profile.full_name,
    "jobTitle": "Padel Trainer",
    "image": profile.avatar_url,
    "url": `https://padeltrainer.ai/trainer/${trainerSlug}`,
    "address": profile.location ? {
      "@type": "PostalAddress",
      "addressLocality": profile.location
    } : undefined,
    ...(averageRating !== null && reviewCount > 0 ? {
      "aggregateRating": {
        "@type": "AggregateRating",
        "ratingValue": averageRating,
        "reviewCount": reviewCount,
        "bestRating": 5,
        "worstRating": 1
      }
    } : {})
  };

  const breadcrumbData = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://padeltrainer.ai" },
      { "@type": "ListItem", "position": 2, "name": "Trainers", "item": "https://padeltrainer.ai/en/trainers" },
      ...(trainerCity ? [{ "@type": "ListItem", "position": 3, "name": trainerCity, "item": `https://padeltrainer.ai/en/trainers/${trainerCitySlug}` }] : []),
      { "@type": "ListItem", "position": trainerCity ? 4 : 3, "name": profile.full_name || 'Trainer' }
    ]
  };

  return (
    <>
      <SEO
        title={profile.full_name || 'Padel Trainer'}
        description={profile.bio || `Book padel lessons with ${profile.full_name || 'this trainer'} in ${profile.location || 'the Netherlands'}. ${trainer.experience_years ? `${trainer.experience_years} years of experience.` : ''} ${trainer.hourly_rate ? `€${trainer.hourly_rate}/hour.` : ''}`}
        url={`/trainer/${trainerSlug}`}
        image={profile.avatar_url || undefined}
        structuredData={[structuredData, breadcrumbData]}
      />
      <ProfileLayout
        bannerUrl={trainerAcademy?.banner_url}
        headerAction={
          !user ? (
            <Button onClick={() => navigate(getAppUrl(`/signup/player?redirect=${encodeURIComponent(window.location.pathname)}`))}>{t('common:signUpToBook', 'Sign Up to Book')}</Button>
          ) : null
        }
      >
        {/* Preview Mode Banner */}
        {user?.id === trainer.user_id && !trainer.is_public && (
          <Alert className="mb-6 border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700">
            <EyeOff className="h-4 w-4 text-amber-600" />
            <AlertDescription>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <p className="font-medium text-amber-800 dark:text-amber-300">Preview mode</p>
                  <p className="text-sm text-amber-700 dark:text-amber-400">Players can't see this yet. This is how your profile will look when you publish.</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button variant="outline" size="sm" onClick={() => navigate('/app/trainer/profile')}>Edit profile</Button>
                  <Button variant="outline" size="sm" onClick={() => navigate('/app/trainer/calendar')}>Add availability</Button>
                  <Button size="sm" onClick={async () => {
                    const { error } = await supabase
                      .from('trainer_profiles')
                      .update({ is_public: true })
                      .eq('user_id', user.id);
                    if (!error) {
                      toast.success('Profile published!');
                      fetchTrainerProfile();
                    }
                  }}>Publish profile</Button>
                </div>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Hero Card */}
        <ProfileHeroCard
          name={profile.full_name || 'Trainer'}
          avatarUrl={profile.avatar_url}
          location={profile.location}
          isVerified={trainer.is_verified}
          hourlyRate={trainer.hourly_rate}
          experienceYears={trainer.experience_years}
          averageRating={averageRating}
          reviewCount={reviewCount}
          socialLinks={socialLinks}
          quote={trainer.favourite_quote}
          videoUrl={trainer.video_url}
          onVideoPlay={() => setShowVideo(true)}
          badgeSlot={
            trainer.preferred_min_rating !== null && trainer.preferred_max_rating !== null && (
              <Badge variant="outline" className="w-fit">
                <Target className="h-3 w-3 mr-1" />
                {t('trainer:profile.bestFor', 'Best for')}: {trainer.preferred_min_rating} - {trainer.preferred_max_rating} {preferredRatingSystemName}
              </Badge>
            )
          }
        >
          {/* Action Buttons */}
          <Button size="lg" className="w-full" onClick={() => navigate(localizePath(`/book/${trainerSlug}`))}>
            <Calendar className="h-4 w-4 mr-2" />
            {t('common:bookLesson', 'Book Lesson')}
          </Button>
          {canFollow && (
            <Button
              variant={isFollowing ? 'secondary' : 'outline'}
              size="lg"
              className="w-full"
              onClick={toggleFollow}
              disabled={followLoading}
            >
              {isFollowing ? (
                <>
                  <UserCheck className="h-4 w-4 mr-2" />
                  {t('common:following', 'Following')}
                </>
              ) : (
                <>
                  <UserPlus className="h-4 w-4 mr-2" />
                  {t('common:follow', 'Follow')}
                </>
              )}
            </Button>
          )}
          <Button variant="outline" size="lg" className="w-full">
            <Mail className="h-4 w-4 mr-2" />
            {t('common:contact', 'Contact')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="lg" className="w-full">
                {copied ? (
                  <>
                    <Check className="h-4 w-4 mr-2" />
                    {t('trainer:profile.copied')}
                  </>
                ) : (
                  <>
                    <Share2 className="h-4 w-4 mr-2" />
                    {t('trainer:profile.shareProfile')}
                  </>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={handleCopyLink}>
                <Copy className="h-4 w-4 mr-2" />
                {t('trainer:profile.copyLink')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleShareWhatsApp}>
                <MessageCircle className="h-4 w-4 mr-2" />
                WhatsApp
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleShareTwitter}>
                <span className="h-4 w-4 mr-2 flex items-center justify-center font-bold text-xs">𝕏</span>
                Twitter / X
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleShareLinkedIn}>
                <Linkedin className="h-4 w-4 mr-2" />
                LinkedIn
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </ProfileHeroCard>

        {/* Video Modal */}
        {showVideo && videoInfo && (
          <div 
            className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
            onClick={() => setShowVideo(false)}
          >
            <div className="relative w-full max-w-4xl aspect-video">
              <button 
                onClick={() => setShowVideo(false)}
                className="absolute -top-10 right-0 text-white hover:text-gray-300"
              >
                ✕ {t('common:close', 'Close')}
              </button>
              <iframe
                src={`${videoInfo.embedUrl}?autoplay=1`}
                className="w-full h-full rounded-lg"
                allow="autoplay; fullscreen"
                allowFullScreen
              />
            </div>
          </div>
        )}

        {/* Content Grid */}
        <ProfileContentGrid>
          {/* Main Content */}
          <ProfileMainColumn>
            {/* Coaching Style Card */}
            {trainer.coaching_method && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Sparkles className="h-5 w-5 text-primary" />
                    {t('trainer:profile.coachingMethod', 'My Coaching Style')}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground whitespace-pre-line">{trainer.coaching_method}</p>
                </CardContent>
              </Card>
            )}

            {/* Video Gallery */}
            <VideoGallery trainerProfileId={trainer.id} />

            {/* About */}
            {profile.bio && (
              <Card>
                <CardHeader>
                  <CardTitle>{t('common:about', 'About')}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground whitespace-pre-line">{profile.bio}</p>
                </CardContent>
              </Card>
            )}

            {/* Academy Affiliation */}
            {trainerAcademy && trainerAcademy.name && (
              <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <GraduationCap className="h-5 w-5 text-primary" />
                    {t('trainer:profile.academy', 'Academy')}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-start gap-4">
                    {trainerAcademy.logo_url && (
                      <img 
                        src={trainerAcademy.logo_url} 
                        alt={trainerAcademy.name} 
                        className="h-16 w-16 rounded-lg object-cover border"
                      />
                    )}
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h4 className="font-semibold">{trainerAcademy.name}</h4>
                        {trainerAcademy.is_verified && (
                          <CheckCircle className="h-4 w-4 text-primary" />
                        )}
                      </div>
                      {trainerAcademy.description && (
                        <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                          {trainerAcademy.description}
                        </p>
                      )}
                      <Button 
                        variant="link" 
                        size="sm" 
                        className="px-0 mt-2"
                        onClick={() => navigate(localizePath(`/academies/${trainerAcademy.slug}`))}
                      >
                        {t('common:viewAcademy', 'View Academy')} →
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Locations */}
            {trainerLocations.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <MapPin className="h-5 w-5 text-primary" />
                    {t('common:trainingLocations', 'Training Locations')}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                <div className="space-y-3">
                    {trainerLocations.map((loc) => {
                      const hasIndoor = loc.location.indoor_courts != null && loc.location.indoor_courts > 0;
                      const hasOutdoor = loc.location.outdoor_courts != null && loc.location.outdoor_courts > 0;
                      return (
                        <div 
                          key={loc.id} 
                          className="flex items-center justify-between p-3 bg-muted rounded-lg cursor-pointer hover:bg-muted/80 transition-colors"
                          onClick={() => navigate(localizePath(`/locations/${loc.location.slug}`))}
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="font-medium">{loc.location.name}</p>
                              {loc.club && (
                                <Badge variant="outline" className="text-xs shrink-0">
                                  <CheckCircle className="h-3 w-3 mr-1" />
                                  Club
                                </Badge>
                              )}
                            </div>
                            <p className="text-sm text-muted-foreground">{loc.location.city}</p>
                            {(hasIndoor || hasOutdoor) && (
                              <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                                {hasIndoor && (
                                  <span className="flex items-center gap-1" title={t('common:indoorCourts', 'Indoor courts')}>
                                    <Building2 className="h-3 w-3" />
                                    {loc.location.indoor_courts} {t('common:indoor', 'indoor')}
                                  </span>
                                )}
                                {hasOutdoor && (
                                  <span className="flex items-center gap-1" title={t('common:outdoorCourts', 'Outdoor courts')}>
                                    <TreePine className="h-3 w-3" />
                                    {loc.location.outdoor_courts} {t('common:outdoor', 'outdoor')}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                          <Button 
                            variant="ghost" 
                            size="sm"
                            className="shrink-0 text-primary"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(localizePath(`/locations/${loc.location.slug}`));
                            }}
                          >
                            {t('common:viewClub', 'View Club')} →
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* City Cross-Link */}
            {trainerCity && trainerCitySlug && (
              <Card>
                <CardContent className="p-4">
                  <LocalizedLink 
                    to={`/trainers/${trainerCitySlug}`}
                    className="flex items-center gap-2 text-primary hover:underline font-medium"
                  >
                    <MapPin className="h-4 w-4" />
                    {t('common:viewAllTrainersIn', { city: trainerCity, defaultValue: `View all trainers in ${trainerCity}` })} →
                  </LocalizedLink>
                </CardContent>
              </Card>
            )}

            {/* Book a Lesson CTA */}
            <Card>
              <CardContent className="p-6 text-center">
                <Calendar className="h-12 w-12 mx-auto mb-3 text-primary opacity-70" />
                <h3 className="font-semibold mb-2">{t('common:bookALesson', 'Book a Lesson')}</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  {t('common:checkAvailableSlots', 'Check available training slots and book your session')}
                </p>
                <Button 
                  className="w-full" 
                  onClick={() => navigate(localizePath(`/book/${trainerSlug}`))}
                >
                  <Calendar className="h-4 w-4 mr-2" />
                  {t('common:bookALesson', 'Book a Lesson')}
                </Button>
              </CardContent>
            </Card>

            {/* Open Slots */}
            {trainer && <TrainerOpenSlots trainerId={trainer.id} trainerSlug={trainerSlug} />}

            {/* Open Registrations */}
            {trainer && <TrainerOpenCycles trainerId={trainer.id} trainerName={profile.full_name || 'Trainer'} />}

            {/* Waiting List - only when enabled */}
            {trainer && (trainer as any).waiting_list_enabled && (
              <WaitingListCard
                ownerType="trainer"
                ownerId={trainer.id}
                ownerName={profile.full_name || 'Trainer'}
              />
            )}

            {/* Reviews Section */}
            {trainer && <TrainerReviews trainerId={trainer.id} />}
          </ProfileMainColumn>

          {/* Sidebar */}
          <ProfileSidebarColumn>
            <ProfileQuickStatsCard
              title={t('common:quickStats', 'Quick Stats')}
              stats={quickStats}
            />

            <ProfileContactCard
              title={t('common:contactInfo', 'Contact Info')}
              description={t('common:contactSharedAfterBooking', 'Contact details are shared after booking a lesson.')}
              action={
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="w-full"
                  onClick={() => navigate(localizePath(`/book/${trainerSlug}`))}
                >
                  <Calendar className="h-4 w-4 mr-2" />
                  {t('common:bookToConnect', 'Book to Connect')}
                </Button>
              }
            />

            {/* Specializations */}
            {trainer.specializations && trainer.specializations.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Star className="h-5 w-5 text-yellow-500" />
                    {t('common:specializations', 'Specializations')}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    {trainer.specializations.map((spec, i) => (
                      <Badge key={i} variant="secondary" className="text-sm py-1 px-3">
                        {spec}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Certifications */}
            {trainer.certifications && trainer.certifications.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Award className="h-5 w-5 text-blue-500" />
                    {t('common:certifications', 'Certifications')}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2">
                    {trainer.certifications.map((cert, i) => (
                      <li key={i} className="flex items-center gap-2">
                        <CheckCircle className="h-4 w-4 text-green-500" />
                        {cert}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            {socialLinks.length > 0 && (
              <ProfileSocialCard
                title={t('common:followMe', 'Follow Me')}
                socialLinks={socialLinks}
              />
            )}
          </ProfileSidebarColumn>
        </ProfileContentGrid>
      </ProfileLayout>
    </>
  );
}
