import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
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
import {
  ProfileLayout,
  ProfileContentGrid,
  ProfileMainColumn,
  ProfileSidebarColumn,
  ProfileFullWidthSection,
  ProfileHeroCard,
  ProfileQuickStatsCard,
} from '@/components/profiles';
import { 
  getAcademyBySlug, 
  getPublicAcademyTrainers, 
  getPublicAcademyLocations,
  recordAcademyProfileView,
  type AcademyProfile 
} from '@/lib/academy';
import { AcademyOpenCycles } from '@/components/academy/AcademyOpenCycles';
import { AcademyReviews } from '@/components/reviews/AcademyReviews';
import { useLocalizedPathFn, useCurrentLanguage } from '@/hooks/useLocalizedPath';
import { useAuth } from '@/hooks/useAuth';

interface TrainerData {
  id: string;
  trainer_profile_id: string;
  trainer_profile: {
    id: string;
    user_id: string;
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
  const { t } = useTranslation(['academy', 'common']);
  const { user } = useAuth();
  const localizePath = useLocalizedPathFn();
  const currentLang = useCurrentLanguage();

  const [academy, setAcademy] = useState<Partial<AcademyProfile> | null>(null);
  const [trainers, setTrainers] = useState<TrainerData[]>([]);
  const [locations, setLocations] = useState<LocationData[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const profileUrl = `${window.location.origin}/${currentLang}/academies/${slug}`;

  useEffect(() => {
    async function fetchData() {
      if (!slug) return;

      try {
        const academyData = await getAcademyBySlug(slug);
        if (!academyData) {
          navigate(localizePath('/academies'));
          return;
        }

        // Only show if public or verified
        if (!academyData.is_public && !academyData.is_verified) {
          navigate(localizePath('/academies'));
          return;
        }

        setAcademy(academyData);

        // Fetch trainers and locations in parallel
        const [trainersData, locationsData] = await Promise.all([
          getPublicAcademyTrainers(academyData.id),
          getPublicAcademyLocations(academyData.id),
        ]);

        setTrainers(trainersData);
        setLocations(locationsData);
      } catch (error) {
        console.error('Error fetching academy:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [slug, navigate, localizePath]);

  useEffect(() => {
    if (academy?.id) {
      recordAcademyProfileView(academy.id);
    }
  }, [academy?.id]);

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

  // Build social links
  const socialLinks = [];
  if (academy?.social_instagram) socialLinks.push({ platform: 'instagram' as const, handle: academy.social_instagram });
  if (academy?.social_facebook) socialLinks.push({ platform: 'facebook' as const, handle: academy.social_facebook });
  if (academy?.social_tiktok) socialLinks.push({ platform: 'tiktok' as const, handle: academy.social_tiktok });
  if (academy?.social_youtube) socialLinks.push({ platform: 'youtube' as const, handle: academy.social_youtube });
  if (academy?.social_linkedin) socialLinks.push({ platform: 'linkedin' as const, handle: academy.social_linkedin });

  // Quick stats
  const quickStats: Array<{ icon: React.ReactNode; label: string; value: string | number }> = [
    { icon: <Users className="h-4 w-4" />, label: t('stats.trainers'), value: trainers.length },
    { icon: <MapPin className="h-4 w-4" />, label: t('stats.locations'), value: locations.length },
  ];

  const avgRating = trainers.filter(t => t.avgRating).reduce((sum, t) => sum + (t.avgRating || 0), 0) / (trainers.filter(t => t.avgRating).length || 1);
  if (trainers.some(t => t.avgRating)) {
    quickStats.push({ icon: <Star className="h-4 w-4" />, label: t('common:avgRating', 'Avg Rating'), value: avgRating.toFixed(1) });
  }

  const breadcrumbs = [
    { label: t('common:navigation.home'), path: '/' },
    { label: t('common:academies', 'Academies'), path: '/academies' },
    { label: academy?.name || '' },
  ];

  const structuredData = academy ? {
    "@context": "https://schema.org",
    "@type": "EducationalOrganization",
    "name": academy.name,
    "description": academy.description,
    "url": profileUrl,
    "logo": academy.logo_url,
    "numberOfEmployees": trainers.length,
    ...(academy.website_url && { "sameAs": [academy.website_url] })
  } : undefined;

  if (loading) {
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
        title={`${academy.name} - Padel Training Academy`}
        description={academy.description || `${academy.name} - Professional padel training academy with ${trainers.length} certified trainers at ${locations.length} locations.`}
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
        {/* Hero Card */}
        <ProfileHeroCard
          name={academy.name}
          avatarUrl={academy.logo_url}
          isVerified={academy.is_verified}
          socialLinks={socialLinks}
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
        >
          {/* Action Buttons */}
          {academy.website_url && (
            <Button
              variant="outline"
              size="lg"
              className="w-full"
              onClick={() => window.open(academy.website_url!, '_blank')}
            >
              <ExternalLink className="h-4 w-4 mr-2" />
              {t('common:visitWebsite', 'Visit Website')}
            </Button>
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
        </ProfileHeroCard>

        {/* Content Grid */}
        <ProfileContentGrid>
          {/* Main Content */}
          <ProfileMainColumn>
            {/* About Card */}
            <Card>
              <CardHeader>
                <CardTitle>{t('profile.about')}</CardTitle>
              </CardHeader>
              <CardContent>
                {academy.description ? (
                  <p className="text-muted-foreground whitespace-pre-wrap">{academy.description}</p>
                ) : (
                  <p className="text-muted-foreground italic">{t('common:noDescription', 'No description available.')}</p>
                )}
              </CardContent>
            </Card>
          </ProfileMainColumn>

          {/* Sidebar */}
          <ProfileSidebarColumn>
            <ProfileQuickStatsCard
              title={t('common:quickStats', 'Quick Stats')}
              stats={quickStats}
            />
          </ProfileSidebarColumn>
        </ProfileContentGrid>

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
                  onClick={() => navigate(localizePath(`/trainer/${trainer.trainer_profile?.id}`))}
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
                          {trainer.trainer_profile?.hourly_rate && (
                            <span className="text-muted-foreground">
                              €{trainer.trainer_profile.hourly_rate}/hr
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

        {/* Full Width - Open Registrations */}
        <ProfileFullWidthSection>
          <AcademyOpenCycles 
            academyId={academy.id!}
            academyName={academy.name || 'Academy'}
          />
        </ProfileFullWidthSection>

        {/* Full Width - Reviews Section */}
        <ProfileFullWidthSection>
          <AcademyReviews academyId={academy.id!} />
        </ProfileFullWidthSection>

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
      </ProfileLayout>
    </>
  );
}
