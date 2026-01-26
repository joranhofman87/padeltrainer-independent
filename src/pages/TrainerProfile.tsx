import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useFollowTrainer } from '@/hooks/useFollowTrainer';
import { useLocalizedPathFn, useCurrentLanguage } from '@/hooks/useLocalizedPath';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { 
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { 
  ArrowLeft, MapPin, Star, Clock, Award, Mail, 
  Calendar, Users, CheckCircle, UserPlus, UserCheck,
  Share2, Copy, Check, MessageCircle, Quote, Play,
  Target, Sparkles, Linkedin
} from 'lucide-react';
import { TrainerReviews } from '@/components/reviews/TrainerReviews';
import { getTrainerAverageRating } from '@/lib/reviews';
import { recordProfileView } from '@/lib/profileViews';
import { parseVideoUrl } from '@/lib/videoEmbed';
import { getRatingSystemByCode } from '@/lib/ratingSystems';
import { toast } from 'sonner';
import { SEO } from '@/components/SEO';
import {
  ProfileLayout,
  ProfileContentGrid,
  ProfileMainColumn,
  ProfileSidebarColumn,
  ProfileHeroCard,
  ProfileQuickStatsCard,
  ProfileContactCard,
  ProfileSocialCard,
} from '@/components/profiles';

interface TrainerData {
  id: string;
  user_id: string;
  hourly_rate: number | null;
  experience_years: number | null;
  certifications: string[] | null;
  specializations: string[] | null;
  is_verified: boolean;
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

interface LessonData {
  id: string;
  title: string;
  description: string | null;
  price: number;
  duration_minutes: number;
  location: string | null;
  min_skill_rating: number | null;
  max_skill_rating: number | null;
  is_active: boolean;
}

interface TrainerLocationData {
  id: string;
  is_primary: boolean;
  relationship_type: string;
  location: {
    id: string;
    name: string;
    city: string;
    slug: string;
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
  const [lessons, setLessons] = useState<LessonData[]>([]);
  const [trainerLocations, setTrainerLocations] = useState<TrainerLocationData[]>([]);
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

  const profileUrl = `${window.location.origin}/${currentLang}/trainer/${trainerId}`;
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
    
    // First, fetch the trainer profile by ID
    const trainerResult = await supabase
      .from('trainer_profiles_safe')
      .select('*')
      .eq('id', trainerId)
      .maybeSingle();

    if (trainerResult.error || !trainerResult.data) {
      console.error('Error fetching trainer:', trainerResult.error);
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
      console.error('Error fetching trainer:', trainerResult.error);
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

    if (!trainerResult.data.is_public && !hasVerifiedClubLink) {
      console.log('Trainer is not public and not linked to verified club');
      setLoading(false);
      return;
    }
    
    setTrainer(trainerResult.data);
    
    const [ratingRes, lessonsResult, locationsResult] = await Promise.all([
      getTrainerAverageRating(trainerResult.data.id),
      supabase
        .from('lessons')
        .select('id, title, description, price, duration_minutes, location, min_skill_rating, max_skill_rating, is_active')
        .eq('trainer_id', trainerResult.data.id)
        .eq('is_active', true)
        .order('title'),
      supabase
        .from('trainer_locations')
        .select(`
          id,
          is_primary,
          relationship_type,
          location:locations(id, name, city, slug)
        `)
        .eq('trainer_id', trainerResult.data.id)
    ]);

    setAverageRating(ratingRes.average);
    setReviewCount(ratingRes.count);
    
    if (lessonsResult.data) {
      setLessons(lessonsResult.data);
    }
    
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

    if (profileResult.error) {
      console.error('Error fetching profile:', profileResult.error);
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
    { icon: <Users className="h-4 w-4" />, label: t('common:students', 'Students'), value: '0' },
    { icon: <Calendar className="h-4 w-4" />, label: t('common:lessonsGiven', 'Lessons Given'), value: '0' },
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

  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Person",
    "name": profile.full_name,
    "jobTitle": "Padel Trainer",
    "image": profile.avatar_url,
    "url": `https://padeltrainer.ai/trainer/${trainerId}`,
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

  return (
    <>
      <SEO
        title={profile.full_name || 'Padel Trainer'}
        description={profile.bio || `Book padel lessons with ${profile.full_name || 'this trainer'} in ${profile.location || 'the Netherlands'}. ${trainer.experience_years ? `${trainer.experience_years} years of experience.` : ''} ${trainer.hourly_rate ? `€${trainer.hourly_rate}/hour.` : ''}`}
        url={`/trainer/${trainerId}`}
        image={profile.avatar_url || undefined}
        structuredData={structuredData}
      />

      <ProfileLayout
        headerAction={
          !user ? (
            <Button onClick={() => navigate(localizePath('/auth'))}>{t('common:signInToBook', 'Sign In to Book')}</Button>
          ) : null
        }
      >
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
          {user && role === 'player' && (
            <Button size="lg" className="w-full" onClick={() => navigate(localizePath(`/book/${trainerId}`))}>
              <Calendar className="h-4 w-4 mr-2" />
              {t('common:bookLesson', 'Book Lesson')}
            </Button>
          )}
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

            {/* Video Section */}
            {videoInfo && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Play className="h-5 w-5 text-primary" />
                    {t('trainer:profile.watchIntro', 'Meet Your Coach')}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="aspect-video rounded-lg overflow-hidden bg-muted">
                    <iframe
                      src={videoInfo.embedUrl}
                      className="w-full h-full"
                      allow="fullscreen"
                      allowFullScreen
                    />
                  </div>
                </CardContent>
              </Card>
            )}

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
                    {trainerLocations.map((loc) => (
                      <div key={loc.id} className="flex items-center justify-between p-3 bg-muted rounded-lg">
                        <div>
                          <p className="font-medium">{loc.location.name}</p>
                          <p className="text-sm text-muted-foreground">{loc.location.city}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          {loc.club && (
                            <Button 
                              variant="outline" 
                              size="sm"
                              onClick={() => navigate(localizePath(`/locations/${loc.location.slug}`))}
                            >
                              {t('common:viewClub', 'View Club')}
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Available Lessons */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Calendar className="h-5 w-5 text-primary" />
                  {t('common:availableLessons', 'Available Lessons')}
                </CardTitle>
                <CardDescription>
                  {t('common:lessonTypesOffered', 'Lesson types offered by this trainer')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {lessons.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Calendar className="h-12 w-12 mx-auto mb-3 opacity-50" />
                    <p>{t('common:noLessonsAvailable', 'No lessons available yet')}</p>
                    <p className="text-sm">{t('common:checkBackSoon', 'Check back soon for available training sessions')}</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {lessons.map((lesson) => (
                      <div key={lesson.id} className="p-4 border rounded-lg hover:border-primary/50 transition-colors">
                        <div className="flex items-start justify-between mb-2">
                          <h4 className="font-semibold">{lesson.title}</h4>
                          <Badge variant="secondary" className="text-primary font-semibold">
                            €{lesson.price}
                          </Badge>
                        </div>
                        {lesson.description && (
                          <p className="text-sm text-muted-foreground mb-2">{lesson.description}</p>
                        )}
                        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {lesson.duration_minutes} min
                          </span>
                          {lesson.location && (
                            <span className="flex items-center gap-1">
                              <MapPin className="h-3 w-3" />
                              {lesson.location}
                            </span>
                          )}
                          {(lesson.min_skill_rating || lesson.max_skill_rating) && (
                            <span className="flex items-center gap-1">
                              <Star className="h-3 w-3" />
                              Level: {lesson.min_skill_rating || '0'} - {lesson.max_skill_rating || '∞'}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {user && role === 'player' && lessons.length > 0 && (
                  <Button 
                    className="w-full mt-4" 
                    onClick={() => navigate(localizePath(`/book/${trainerId}`))}
                  >
                    <Calendar className="h-4 w-4 mr-2" />
                    {t('common:bookALesson', 'Book a Lesson')}
                  </Button>
                )}
              </CardContent>
            </Card>

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
                user && role === 'player' ? (
                  <Button 
                    variant="outline" 
                    size="sm" 
                    className="w-full"
                    onClick={() => navigate(localizePath(`/book/${trainerId}`))}
                  >
                    <Calendar className="h-4 w-4 mr-2" />
                    {t('common:bookToConnect', 'Book to Connect')}
                  </Button>
                ) : null
              }
            />

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
