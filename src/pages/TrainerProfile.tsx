import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useFollowTrainer } from '@/hooks/useFollowTrainer';
import { useLocalizedPathFn, useCurrentLanguage } from '@/hooks/useLocalizedPath';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
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
  Instagram, Youtube, Linkedin, Target, Sparkles
} from 'lucide-react';
import { TrainerReviews } from '@/components/reviews/TrainerReviews';
import { StarRating } from '@/components/reviews/StarRating';
import { getTrainerAverageRating } from '@/lib/reviews';
import { recordProfileView } from '@/lib/profileViews';
import { parseVideoUrl } from '@/lib/videoEmbed';
import { getRatingSystemByCode } from '@/lib/ratingSystems';
import { toast } from 'sonner';
import { SEO } from '@/components/SEO';

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
  const { t } = useTranslation('trainer');
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

  // Record anonymous profile view
  useEffect(() => {
    if (trainer?.id) {
      recordProfileView(trainer.id);
    }
  }, [trainer?.id]);

  // Fetch preferred rating system name
  useEffect(() => {
    if (trainer?.preferred_rating_system) {
      getRatingSystemByCode(trainer.preferred_rating_system).then(system => {
        if (system) setPreferredRatingSystemName(system.name);
      });
    }
  }, [trainer?.preferred_rating_system]);

  const fetchTrainerProfile = async () => {
    setLoading(true);
    
    const [trainerResult, profileResult] = await Promise.all([
      supabase
        .from('trainer_profiles')
        .select('*')
        .eq('user_id', trainerId)
        .single(),
      supabase
        .from('profiles_public')
        .select('full_name, avatar_url, bio, location')
        .eq('user_id', trainerId)
        .single()
    ]);

    if (trainerResult.error) {
      console.error('Error fetching trainer:', trainerResult.error);
      setLoading(false);
      return;
    }
    
    setTrainer(trainerResult.data);
    
    // Fetch additional data in parallel
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
      // Fetch club profiles for these locations
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

  const getInitials = (name: string | null) => {
    if (!name) return 'T';
    return name.split(' ').map(n => n[0]).join('').toUpperCase();
  };

  const getSocialUrl = (platform: string, value: string | null) => {
    if (!value) return null;
    if (value.startsWith('http')) return value;
    const cleanHandle = value.replace('@', '');
    switch (platform) {
      case 'instagram': return `https://instagram.com/${cleanHandle}`;
      case 'tiktok': return `https://tiktok.com/@${cleanHandle}`;
      case 'youtube': return value.startsWith('http') ? value : `https://youtube.com/@${cleanHandle}`;
      case 'linkedin': return value;
      default: return null;
    }
  };

  const hasSocialLinks = trainer?.social_instagram || trainer?.social_tiktok || 
                          trainer?.social_youtube || trainer?.social_linkedin;

  const videoInfo = trainer?.video_url ? parseVideoUrl(trainer.video_url) : null;

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!trainer || !profile) {
    return (
      <div className="min-h-screen bg-background">
        <header className="border-b">
          <div className="container mx-auto px-4 py-4">
            <Button variant="ghost" onClick={() => navigate(-1)}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
          </div>
        </header>
        <main className="container mx-auto px-4 py-12 text-center">
          <h1 className="text-2xl font-bold mb-2">Trainer Not Found</h1>
          <p className="text-muted-foreground mb-4">This trainer profile doesn't exist or has been removed.</p>
          <Button onClick={() => navigate(localizePath('/trainers'))}>Browse Trainers</Button>
        </main>
      </div>
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
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10">
      <SEO
        title={profile.full_name || 'Padel Trainer'}
        description={profile.bio || `Book padel lessons with ${profile.full_name || 'this trainer'} in ${profile.location || 'the Netherlands'}. ${trainer.experience_years ? `${trainer.experience_years} years of experience.` : ''} ${trainer.hourly_rate ? `€${trainer.hourly_rate}/hour.` : ''}`}
        url={`/trainer/${trainerId}`}
        image={profile.avatar_url || undefined}
        structuredData={structuredData}
      />
      
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <Button variant="ghost" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
          {!user && (
            <Button onClick={() => navigate(localizePath('/auth'))}>Sign In to Book</Button>
          )}
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-5xl">
        {/* Hero Section */}
        <Card className="mb-8 overflow-hidden">
          <CardContent className="p-0">
            <div className="relative bg-gradient-to-r from-primary/10 via-primary/5 to-transparent p-6 md:p-10">
              <div className="flex flex-col lg:flex-row gap-8">
                {/* Avatar with video play button */}
                <div className="relative mx-auto lg:mx-0">
                  <Avatar className="h-36 w-36 ring-4 ring-background shadow-xl">
                    <AvatarImage src={profile.avatar_url || undefined} />
                    <AvatarFallback className="text-4xl bg-primary text-primary-foreground">
                      {getInitials(profile.full_name)}
                    </AvatarFallback>
                  </Avatar>
                  {videoInfo && (
                    <button 
                      onClick={() => setShowVideo(true)}
                      className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-full opacity-0 hover:opacity-100 transition-opacity"
                    >
                      <div className="bg-white/90 rounded-full p-3">
                        <Play className="h-6 w-6 text-primary fill-primary" />
                      </div>
                    </button>
                  )}
                </div>
                
                {/* Main Info */}
                <div className="flex-1 text-center lg:text-left">
                  <div className="flex flex-col lg:flex-row lg:items-center gap-2 mb-3">
                    <h1 className="text-3xl md:text-4xl font-bold">{profile.full_name || 'Trainer'}</h1>
                    {trainer.is_verified && (
                      <Badge className="w-fit mx-auto lg:mx-0 bg-green-500 hover:bg-green-600">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        Verified
                      </Badge>
                    )}
                  </div>
                  
                  {/* Location & Quick Stats */}
                  <div className="flex flex-wrap gap-4 justify-center lg:justify-start mb-4">
                    {profile.location && (
                      <span className="text-muted-foreground flex items-center gap-1">
                        <MapPin className="h-4 w-4" />
                        {profile.location}
                      </span>
                    )}
                    {trainer.hourly_rate && (
                      <span className="flex items-center gap-1">
                        <span className="font-bold text-xl text-primary">€{trainer.hourly_rate}</span>
                        <span className="text-muted-foreground">/hour</span>
                      </span>
                    )}
                    {trainer.experience_years && (
                      <span className="text-muted-foreground flex items-center gap-1">
                        <Clock className="h-4 w-4" />
                        {trainer.experience_years} years
                      </span>
                    )}
                    {averageRating !== null && (
                      <span className="flex items-center gap-1">
                        <StarRating rating={averageRating} size="sm" />
                        <span className="text-muted-foreground">({reviewCount})</span>
                      </span>
                    )}
                  </div>

                  {/* Social Links */}
                  {hasSocialLinks && (
                    <div className="flex gap-3 justify-center lg:justify-start mb-4">
                      {trainer.social_instagram && (
                        <a 
                          href={getSocialUrl('instagram', trainer.social_instagram) || '#'}
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="p-2 rounded-full bg-muted hover:bg-muted/80 transition-colors"
                        >
                          <Instagram className="h-5 w-5" />
                        </a>
                      )}
                      {trainer.social_tiktok && (
                        <a 
                          href={getSocialUrl('tiktok', trainer.social_tiktok) || '#'}
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="p-2 rounded-full bg-muted hover:bg-muted/80 transition-colors"
                        >
                          <span className="text-lg font-bold">♪</span>
                        </a>
                      )}
                      {trainer.social_youtube && (
                        <a 
                          href={getSocialUrl('youtube', trainer.social_youtube) || '#'}
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="p-2 rounded-full bg-muted hover:bg-muted/80 transition-colors"
                        >
                          <Youtube className="h-5 w-5" />
                        </a>
                      )}
                      {trainer.social_linkedin && (
                        <a 
                          href={getSocialUrl('linkedin', trainer.social_linkedin) || '#'}
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="p-2 rounded-full bg-muted hover:bg-muted/80 transition-colors"
                        >
                          <Linkedin className="h-5 w-5" />
                        </a>
                      )}
                    </div>
                  )}

                  {/* Favourite Quote */}
                  {trainer.favourite_quote && (
                    <blockquote className="relative pl-4 border-l-2 border-primary/50 italic text-muted-foreground mb-4">
                      <Quote className="absolute -left-3 -top-2 h-5 w-5 text-primary/30" />
                      "{trainer.favourite_quote}"
                    </blockquote>
                  )}

                  {/* Preferred Player Levels Badge */}
                  {trainer.preferred_min_rating !== null && trainer.preferred_max_rating !== null && (
                    <Badge variant="outline" className="mb-2">
                      <Target className="h-3 w-3 mr-1" />
                      {t('profile.bestFor', 'Best for')}: {trainer.preferred_min_rating} - {trainer.preferred_max_rating} {preferredRatingSystemName}
                    </Badge>
                  )}
                </div>

                {/* Action Buttons */}
                <div className="flex flex-col gap-2 w-full lg:w-auto lg:min-w-[180px]">
                  {user && role === 'player' && (
                    <Button size="lg" className="w-full" onClick={() => navigate(localizePath(`/book/${trainerId}`))}>
                      <Calendar className="h-4 w-4 mr-2" />
                      Book Lesson
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
                          Following
                        </>
                      ) : (
                        <>
                          <UserPlus className="h-4 w-4 mr-2" />
                          Follow
                        </>
                      )}
                    </Button>
                  )}
                  <Button variant="outline" size="lg" className="w-full">
                    <Mail className="h-4 w-4 mr-2" />
                    Contact
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="lg" className="w-full">
                        {copied ? (
                          <>
                            <Check className="h-4 w-4 mr-2" />
                            {t('profile.copied')}
                          </>
                        ) : (
                          <>
                            <Share2 className="h-4 w-4 mr-2" />
                            {t('profile.shareProfile')}
                          </>
                        )}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem onClick={handleCopyLink}>
                        <Copy className="h-4 w-4 mr-2" />
                        {t('profile.copyLink')}
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
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

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
                ✕ Close
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

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            {/* Coaching Style Card */}
            {trainer.coaching_method && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Sparkles className="h-5 w-5 text-primary" />
                    {t('profile.coachingMethod', 'My Coaching Style')}
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
                    {t('profile.watchIntro', 'Meet Your Coach')}
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
                  <CardTitle>About</CardTitle>
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
                    Specializations
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
                    Certifications
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
                    Training Locations
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
                          {loc.is_primary && (
                            <Badge variant="secondary" className="text-xs">Primary</Badge>
                          )}
                          {loc.club && (
                            <Button 
                              variant="outline" 
                              size="sm"
                              onClick={() => navigate(`/locations/${loc.location.slug}`)}
                            >
                              View Club
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
                  Available Lessons
                </CardTitle>
                <CardDescription>
                  Lesson types offered by this trainer
                </CardDescription>
              </CardHeader>
              <CardContent>
                {lessons.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Calendar className="h-12 w-12 mx-auto mb-3 opacity-50" />
                    <p>No lessons available yet</p>
                    <p className="text-sm">Check back soon for available training sessions</p>
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
                    onClick={() => navigate(`/book/${trainerId}`)}
                  >
                    <Calendar className="h-4 w-4 mr-2" />
                    Book a Lesson
                  </Button>
                )}
              </CardContent>
            </Card>

            {/* Reviews Section */}
            {trainer && <TrainerReviews trainerId={trainer.id} />}
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Quick Stats */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Quick Stats</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground flex items-center gap-2">
                    <Users className="h-4 w-4" />
                    Students
                  </span>
                  <span className="font-semibold">0</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground flex items-center gap-2">
                    <Calendar className="h-4 w-4" />
                    Lessons Given
                  </span>
                  <span className="font-semibold">0</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground flex items-center gap-2">
                    <Star className="h-4 w-4" />
                    Rating
                  </span>
                  <span className="font-semibold">
                    {averageRating !== null ? `${averageRating} ★` : '—'}
                  </span>
                </div>
                {trainer.preferred_min_rating !== null && trainer.preferred_max_rating !== null && (
                  <>
                    <Separator />
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground flex items-center gap-2">
                        <Target className="h-4 w-4" />
                        Preferred Levels
                      </span>
                      <span className="font-semibold text-sm">
                        {trainer.preferred_min_rating}-{trainer.preferred_max_rating}
                      </span>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {/* Contact Card */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Contact Info</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Contact details are shared after booking a lesson.
                </p>
                {user && role === 'player' && (
                  <Button 
                    variant="outline" 
                    size="sm" 
                    className="w-full"
                    onClick={() => navigate(`/book/${trainerId}`)}
                  >
                    <Calendar className="h-4 w-4 mr-2" />
                    Book to Connect
                  </Button>
                )}
              </CardContent>
            </Card>

            {/* Social Links Card (Desktop) */}
            {hasSocialLinks && (
              <Card className="hidden lg:block">
                <CardHeader>
                  <CardTitle className="text-base">Follow Me</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex gap-3">
                    {trainer.social_instagram && (
                      <a 
                        href={getSocialUrl('instagram', trainer.social_instagram) || '#'}
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="p-3 rounded-lg bg-muted hover:bg-muted/80 transition-colors flex-1 flex flex-col items-center gap-1"
                      >
                        <Instagram className="h-5 w-5" />
                        <span className="text-xs">Instagram</span>
                      </a>
                    )}
                    {trainer.social_youtube && (
                      <a 
                        href={getSocialUrl('youtube', trainer.social_youtube) || '#'}
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="p-3 rounded-lg bg-muted hover:bg-muted/80 transition-colors flex-1 flex flex-col items-center gap-1"
                      >
                        <Youtube className="h-5 w-5" />
                        <span className="text-xs">YouTube</span>
                      </a>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
