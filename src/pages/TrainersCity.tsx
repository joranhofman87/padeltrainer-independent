import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { supabase } from '@/lib/supabaseClient';
import { LocalizedLink } from '@/components/LocalizedLink';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Search, MapPin, Star, ArrowLeft, TrendingUp, Building2, ChevronRight } from 'lucide-react';
import { FollowButton } from '@/components/trainers/FollowButton';
import { getTrainerAverageRating } from '@/lib/reviews';
import { getTrainerIdsInPaidAcademies } from '@/lib/academy';
import { getActiveLocations, getLocationTrainerCounts, getClaimedLocationIds, type Location } from '@/lib/locations';
import { LocationCard } from '@/components/locations/LocationCard';
import { SEO } from '@/components/SEO';
import { useTranslation } from 'react-i18next';
import MarketingLayout from '@/components/marketing/MarketingLayout';

interface TrainerWithProfile {
  id: string;
  user_id: string;
  slug: string | null;
  hourly_rate: number | null;
  experience_years: number | null;
  certifications: string[] | null;
  specializations: string[] | null;
  is_verified: boolean;
  profile: {
    full_name: string | null;
    avatar_url: string | null;
    bio: string | null;
    location: string | null;
    skill_rating: number | null;
    rating_system: string | null;
  } | null;
  averageRating: number;
  reviewCount: number;
}

type SortOption = 'rating' | 'price-low' | 'price-high' | 'experience';

export default function TrainersCity() {
  const { city } = useParams<{ city: string }>();
  const [trainers, setTrainers] = useState<TrainerWithProfile[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [trainerCounts, setTrainerCounts] = useState<Record<string, number>>({});
  const [claimedLocationIds, setClaimedLocationIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('rating');
  const navigate = useNavigate();
  const { user } = useAuth();
  const { t } = useTranslation('common');
  const localizePath = useLocalizedPathFn();

  // Format city name for display (capitalize first letter of each word)
  const displayCity = useMemo(() => {
    if (!city) return '';
    return city
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }, [city]);

  useEffect(() => {
    if (city) {
      fetchData();
    }
  }, [city]);

  const fetchData = async () => {
    setLoading(true);

    // Fetch locations in this city, trainer counts, and claimed IDs in parallel
    const [allLocations, allTrainerCounts, allClaimedIds] = await Promise.all([
      getActiveLocations(),
      getLocationTrainerCounts(),
      getClaimedLocationIds()
    ]);
    
    const cityLocations = allLocations.filter(
      l => l.city.toLowerCase().replace(/\s+/g, '-') === city?.toLowerCase()
    );
    setLocations(cityLocations);
    setTrainerCounts(allTrainerCounts);
    setClaimedLocationIds(allClaimedIds);

    // Fetch all public trainers, then filter by subscription/academy
    const now = new Date().toISOString();
    const { data: allPublicTrainers, error: trainerError } = await supabase
      .from('trainer_profiles_safe')
      .select('id, user_id, slug, hourly_rate, experience_years, certifications, specializations, is_verified, is_public, subscription_status, trial_ends_at')
      .eq('is_public', true);

    if (trainerError) {
      console.error('Error fetching trainers:', trainerError);
      setLoading(false);
      return;
    }

    // Check which trainers are in paid academies
    const allTrainerIds = allPublicTrainers.map(t => t.id);
    const paidAcademyTrainerIds = await getTrainerIdsInPaidAcademies(allTrainerIds);

    // Filter: subscription_status='active' OR trial_ends_at > now() OR in paid academy
    const trainerProfiles = allPublicTrainers.filter(t =>
      t.subscription_status === 'active' ||
      (t.trial_ends_at && t.trial_ends_at > now) ||
      paidAcademyTrainerIds.has(t.id)
    );

    // Fetch profiles
    const userIds = trainerProfiles.map(t => t.user_id);
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles_public')
      .select('user_id, full_name, avatar_url, bio, location, skill_rating, rating_system')
      .in('user_id', userIds);

    if (profilesError) {
      console.error('Error fetching profiles:', profilesError);
      setLoading(false);
      return;
    }

    // Fetch trainer_locations to see who teaches at locations in this city
    const locationIds = cityLocations.map(l => l.id);
    const { data: trainerLocationLinks } = await supabase
      .from('trainer_locations')
      .select('trainer_id')
      .in('location_id', locationIds);

    const trainerIdsAtLocations = new Set(trainerLocationLinks?.map(tl => tl.trainer_id) || []);

    // Filter trainers: either linked to a location in this city OR profile.location matches
    const cityTrainerProfiles = trainerProfiles.filter(trainer => {
      const profile = profiles?.find(p => p.user_id === trainer.user_id);
      const profileLocationMatches = profile?.location?.toLowerCase().includes(displayCity.toLowerCase());
      const linkedToLocation = trainerIdsAtLocations.has(trainer.id);
      return profileLocationMatches || linkedToLocation;
    });

    // Fetch ratings
    const trainersWithRatings = await Promise.all(
      cityTrainerProfiles.map(async (trainer) => {
        const { average, count } = await getTrainerAverageRating(trainer.id);
        return {
          ...trainer,
          profile: profiles?.find(p => p.user_id === trainer.user_id) || null,
          averageRating: average || 0,
          reviewCount: count,
        };
      })
    );

    setTrainers(trainersWithRatings);
    setLoading(false);
  };

  const filteredAndSortedTrainers = useMemo(() => {
    let result = trainers.filter(trainer => {
      if (!searchQuery) return true;
      return (
        trainer.profile?.full_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        trainer.profile?.bio?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        trainer.specializations?.some(s => s.toLowerCase().includes(searchQuery.toLowerCase()))
      );
    });

    result.sort((a, b) => {
      switch (sortBy) {
        case 'rating':
          return b.averageRating - a.averageRating;
        case 'price-low':
          return (a.hourly_rate || 0) - (b.hourly_rate || 0);
        case 'price-high':
          return (b.hourly_rate || 0) - (a.hourly_rate || 0);
        case 'experience':
          return (b.experience_years || 0) - (a.experience_years || 0);
        default:
          return 0;
      }
    });

    return result;
  }, [trainers, searchQuery, sortBy]);

  const getInitials = (name: string | null) => {
    if (!name) return 'T';
    return name.split(' ').map(n => n[0]).join('').toUpperCase();
  };

  // SEO structured data
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": `Padel Trainers in ${displayCity}`,
    "description": `Find ${trainers.length} certified padel trainers in ${displayCity}. Compare rates, read reviews, and book lessons.`,
    "numberOfItems": filteredAndSortedTrainers.length,
    "itemListElement": filteredAndSortedTrainers.slice(0, 10).map((trainer, index) => ({
      "@type": "ListItem",
      "position": index + 1,
      "item": {
        "@type": "Person",
        "name": trainer.profile?.full_name || "Padel Trainer",
        "jobTitle": "Padel Trainer",
        "image": trainer.profile?.avatar_url,
        "address": {
          "@type": "PostalAddress",
          "addressLocality": displayCity
        }
      }
    }))
  };

  const faqStructuredData = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      {
        "@type": "Question",
        "name": `How much do padel lessons cost in ${displayCity}?`,
        "acceptedAnswer": {
          "@type": "Answer",
          "text": trainers.length > 0
            ? `Padel lessons in ${displayCity} typically range from €${Math.min(...trainers.map(t => t.hourly_rate || 50))} to €${Math.max(...trainers.map(t => t.hourly_rate || 50))} per hour. Prices vary based on trainer experience, certifications, and lesson type.`
            : `Padel lesson prices in ${displayCity} vary based on trainer experience and qualifications. Contact trainers directly for current rates.`
        }
      },
      {
        "@type": "Question",
        "name": `How do I find a padel trainer near me in ${displayCity}?`,
        "acceptedAnswer": {
          "@type": "Answer",
          "text": `Browse our directory of ${trainers.length} certified padel trainers in ${displayCity}. Compare ratings, read reviews, and book lessons directly through PadelTrainer.ai.`
        }
      }
    ]
  };

  return (
    <MarketingLayout>
      <SEO
        title={`Padel Trainers in ${displayCity} | Find & Book Lessons`}
        description={`Find ${trainers.length} certified padel trainers in ${displayCity}. Compare rates from €${trainers.length > 0 ? Math.min(...trainers.map(t => t.hourly_rate || 50)) : 30}/hour, read reviews, and book your first lesson today.`}
        url={`/trainers/${city}`}
        image="https://padeltrainer.ai/og-trainers.png"
        structuredData={[structuredData, faqStructuredData]}
      />

      {/* Breadcrumbs */}
      <div className="border-b bg-muted/30">
        <div className="container mx-auto px-4 py-3">
          <nav className="flex items-center gap-2 text-sm text-muted-foreground">
            <LocalizedLink to="/" className="hover:text-primary transition-colors">Home</LocalizedLink>
            <ChevronRight className="h-4 w-4" />
            <LocalizedLink to="/trainers" className="hover:text-primary transition-colors">Trainers</LocalizedLink>
            <ChevronRight className="h-4 w-4" />
            <span className="text-foreground font-medium">{displayCity}</span>
          </nav>
        </div>
      </div>

      <main className="container mx-auto px-4 py-8">
        {/* Hero Section */}
        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold mb-3">
            Padel Trainers in {displayCity}
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl">
            {trainers.length > 0
              ? `Discover ${trainers.length} certified padel trainer${trainers.length !== 1 ? 's' : ''} in ${displayCity}. Compare rates, read reviews, and book lessons that match your skill level.`
              : `Looking for padel trainers in ${displayCity}? Check back soon or explore nearby cities.`
            }
          </p>
        </div>

        {/* Search and Sort */}
        <div className="mb-6 flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search trainers by name, specialty..."
              className="pl-10"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortOption)}>
            <SelectTrigger className="w-full sm:w-[160px]">
              <TrendingUp className="h-4 w-4 mr-2" />
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="rating">Top Rated</SelectItem>
              <SelectItem value="price-low">Price: Low to High</SelectItem>
              <SelectItem value="price-high">Price: High to Low</SelectItem>
              <SelectItem value="experience">Most Experienced</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <p className="text-sm text-muted-foreground mb-6">
          {filteredAndSortedTrainers.length} trainer{filteredAndSortedTrainers.length !== 1 ? 's' : ''} found in {displayCity}
        </p>

        {/* Trainers Grid */}
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        ) : filteredAndSortedTrainers.length === 0 ? (
          <Card className="text-center py-12">
            <CardContent>
              <p className="text-muted-foreground mb-4">No trainers found in {displayCity}</p>
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <Button variant="outline" asChild>
                  <LocalizedLink to="/trainers">View All Trainers</LocalizedLink>
                </Button>
                <Button asChild>
                  <Link to="/app/signup/trainer">Become a Trainer</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredAndSortedTrainers.map((trainer) => (
              <Card
                key={trainer.id}
                className="cursor-pointer hover:shadow-lg transition-all hover:border-primary/50"
                onClick={() => navigate(localizePath(`/trainer/${trainer.slug || trainer.id}`))}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start gap-4">
                    <Avatar className="h-16 w-16">
                      <AvatarImage src={trainer.profile?.avatar_url || undefined} />
                      <AvatarFallback className="text-lg">
                        {getInitials(trainer.profile?.full_name)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <CardTitle className="text-lg truncate">
                          {trainer.profile?.full_name || 'Trainer'}
                        </CardTitle>
                        {trainer.is_verified && (
                          <Badge variant="secondary" className="shrink-0">
                            Verified
                          </Badge>
                        )}
                        <div className="ml-auto" onClick={(e) => e.stopPropagation()}>
                          <FollowButton trainerProfileId={trainer.id} />
                        </div>
                      </div>
                      {trainer.profile?.location && (
                        <CardDescription className="flex items-center gap-1 mt-1">
                          <MapPin className="h-3 w-3" />
                          {trainer.profile.location}
                        </CardDescription>
                      )}
                      {trainer.reviewCount > 0 && (
                        <div className="flex items-center gap-1 mt-1">
                          <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                          <span className="font-medium">{trainer.averageRating.toFixed(1)}</span>
                          <span className="text-sm text-muted-foreground">
                            ({trainer.reviewCount} review{trainer.reviewCount !== 1 ? 's' : ''})
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {trainer.profile?.bio && (
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {trainer.profile.bio}
                    </p>
                  )}

                  <div className="flex items-center justify-between text-sm">
                    {trainer.hourly_rate && (
                      <span className="font-semibold text-primary">
                        €{trainer.hourly_rate}/hour
                      </span>
                    )}
                    <div className="flex items-center gap-3 text-muted-foreground">
                      {trainer.profile?.skill_rating && trainer.profile?.rating_system && (
                        <span className="font-medium text-foreground">
                          {trainer.profile.rating_system.toUpperCase()} {trainer.profile.skill_rating}
                        </span>
                      )}
                      {trainer.experience_years && (
                        <span>
                          {trainer.experience_years}y exp.
                        </span>
                      )}
                    </div>
                  </div>

                  {trainer.specializations && trainer.specializations.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {trainer.specializations.slice(0, 3).map((spec, i) => (
                        <Badge key={i} variant="outline" className="text-xs">
                          {spec}
                        </Badge>
                      ))}
                      {trainer.specializations.length > 3 && (
                        <Badge variant="outline" className="text-xs">
                          +{trainer.specializations.length - 3}
                        </Badge>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Clubs Section */}
        {locations.length > 0 && (
          <section className="mt-12">
            <h2 className="text-2xl font-semibold mb-4 flex items-center gap-2">
              <Building2 className="h-6 w-6" />
              Padel Clubs in {displayCity}
            </h2>
            <p className="text-muted-foreground mb-6">
              {locations.length} padel club{locations.length !== 1 ? 's' : ''} in {displayCity}
            </p>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {locations.map(location => (
                <LocationCard
                  key={location.id}
                  location={location}
                  trainerCount={trainerCounts[location.id] || 0}
                  isClaimed={claimedLocationIds.has(location.id)}
                />
              ))}
            </div>
          </section>
        )}

        {/* SEO Content Section */}
        <section className="mt-16 prose prose-gray dark:prose-invert max-w-none">
          <h2>About Padel Training in {displayCity}</h2>
          <p>
            Whether you're a beginner looking to learn the basics or an experienced player wanting to refine your technique,
            finding the right padel trainer in {displayCity} is essential for your development. Our certified trainers offer
            personalized coaching tailored to your skill level and goals.
          </p>
          <h3>What to Expect from Padel Lessons</h3>
          <ul>
            <li>Technical training covering serves, volleys, and defensive play</li>
            <li>Tactical strategies for singles and doubles matches</li>
            <li>Physical conditioning specific to padel</li>
            <li>Match play analysis and improvement tips</li>
          </ul>
          {locations.length > 0 && (
            <>
              <h3>Popular Padel Clubs in {displayCity}</h3>
              <p>
                {displayCity} is home to {locations.length} padel {locations.length === 1 ? 'club' : 'clubs'} where you can take lessons and practice.
                {locations.slice(0, 3).map((l, i) => (
                  <span key={l.id}>
                    {i > 0 && ', '}
                    {i === Math.min(locations.length - 1, 2) && i > 0 && 'and '}
                    <LocalizedLink to={`/locations/${l.slug}`} className="text-primary hover:underline">{l.name}</LocalizedLink>
                  </span>
                ))}
                {locations.length > 3 && ` and ${locations.length - 3} more`}.
              </p>
            </>
          )}
        </section>
      </main>
    </MarketingLayout>
  );
}
