import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { MapPin, ExternalLink, ArrowLeft, Loader2, Star, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { FollowButton } from '@/components/trainers/FollowButton';
import { getLocationBySlug, getTrainersAtLocation, type Location } from '@/lib/locations';
import { supabase } from '@/integrations/supabase/client';
import { useTranslation } from 'react-i18next';

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

export default function LocationDetail() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation('common');
  const [location, setLocation] = useState<Location | null>(null);
  const [trainers, setTrainers] = useState<TrainerWithProfile[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      if (!slug) return;

      try {
        const locationData = await getLocationBySlug(slug);
        if (!locationData) {
          navigate('/locations');
          return;
        }
        setLocation(locationData);

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
  }, [slug, navigate]);

  const getInitials = (name: string | null | undefined) => {
    if (!name) return 'T';
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
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

  return (
    <MarketingLayout>
      <div className="min-h-screen bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10">
        {/* Header */}
        <div className="bg-gradient-to-r from-primary/10 to-primary/5 border-b">
          <div className="container mx-auto px-4 py-8">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate('/locations')}
              className="mb-4"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              {t('locations.backToLocations', 'Back to Locations')}
            </Button>

            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
              <div>
                <h1 className="text-3xl font-bold mb-2">{location.name}</h1>
                <div className="flex items-start gap-2 text-muted-foreground">
                  <MapPin className="h-5 w-5 mt-0.5 shrink-0" />
                  <div>
                    {location.street_address && <span>{location.street_address}, </span>}
                    <span>{location.postal_code} {location.city}</span>
                  </div>
                </div>
              </div>

              <div className="flex gap-2">
                {location.website_url && (
                  <Button
                    variant="outline"
                    onClick={() => window.open(location.website_url!, '_blank')}
                  >
                    <ExternalLink className="h-4 w-4 mr-2" />
                    {t('locations.visitWebsite', 'Visit Website')}
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={() => window.open(`https://maps.google.com/?q=${encodeURIComponent(`${location.street_address || ''} ${location.postal_code} ${location.city}`)}`, '_blank')}
                >
                  <MapPin className="h-4 w-4 mr-2" />
                  {t('locations.getDirections', 'Get Directions')}
                </Button>
              </div>
            </div>
          </div>
        </div>

        {/* Trainers */}
        <div className="container mx-auto px-4 py-8">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-semibold flex items-center gap-2">
              <Users className="h-6 w-6 text-primary" />
              {t('locations.trainersAtLocation', 'Trainers at this location')}
            </h2>
            <Badge variant="secondary" className="text-sm">
              {trainers.length} {trainers.length === 1 ? t('locations.trainer', 'trainer') : t('locations.trainers', 'trainers')}
            </Badge>
          </div>

          {trainers.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Users className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">{t('locations.noTrainers', 'No trainers yet')}</h3>
                <p className="text-muted-foreground">
                  {t('locations.noTrainersDescription', 'No trainers are currently teaching at this location.')}
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {trainers.map(trainer => (
                <Card
                  key={trainer.id}
                  className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
                  onClick={() => navigate(`/trainer/${trainer.trainer_id}`)}
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
                              {t('verified', 'Verified')}
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
                          €{trainer.trainer_profiles.hourly_rate}{t('perHour', '/hour')}
                        </span>
                      )}
                      {trainer.trainer_profiles.experience_years && (
                        <span className="text-muted-foreground">
                          {trainer.trainer_profiles.experience_years}{t('yearsExp', 'y exp.')}
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
                        {t('locations.primaryLocation', 'Primary Location')}
                      </Badge>
                    )}

                    <div className="flex gap-2 pt-2" onClick={e => e.stopPropagation()}>
                      <Button
                        variant="default"
                        size="sm"
                        className="flex-1"
                        onClick={() => navigate(`/book/${trainer.trainer_id}`)}
                      >
                        {t('locations.bookLesson', 'Book Lesson')}
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
    </MarketingLayout>
  );
}
