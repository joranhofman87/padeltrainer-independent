import { useNavigate } from 'react-router-dom';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import { useAuth } from '@/hooks/useAuth';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { signOut } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import { Search, Calendar, Star, User, LogOut, TrendingUp, MapPin, ChevronRight, Clock, Users, Bell, Settings, CalendarSync } from 'lucide-react';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { supabase } from '@/integrations/supabase/client';
import { format, isAfter } from 'date-fns';
import { RatingHistoryChart } from '@/components/player/RatingHistoryChart';

interface FollowedTrainer {
  id: string;
  trainer_user_id: string;
  full_name: string | null;
  avatar_url: string | null;
}

interface FeaturedTrainer {
  id: string;
  hourly_rate: number | null;
  experience_years: number | null;
  specializations: string[] | null;
  is_verified: boolean;
  profile: {
    full_name: string | null;
    avatar_url: string | null;
    location: string | null;
  } | null;
}

interface UpcomingBooking {
  id: string;
  lessonTitle: string;
  trainerName: string;
  startTime: Date;
  location: string | null;
}

interface PlayerStats {
  totalBookings: number;
  completedLessons: number;
  upcomingCount: number;
}

export default function PlayerDashboard() {
  const { user, profile, loading } = useAuth();
  const navigate = useNavigate();
  const localizePath = useLocalizedPathFn();
  const { toast } = useToast();
  const [featuredTrainers, setFeaturedTrainers] = useState<FeaturedTrainer[]>([]);
  const [loadingTrainers, setLoadingTrainers] = useState(true);
  const [upcomingBookings, setUpcomingBookings] = useState<UpcomingBooking[]>([]);
  const [playerStats, setPlayerStats] = useState<PlayerStats>({ totalBookings: 0, completedLessons: 0, upcomingCount: 0 });
  const [statsLoading, setStatsLoading] = useState(true);
  const [followedTrainers, setFollowedTrainers] = useState<FollowedTrainer[]>([]);
  const [followingLoading, setFollowingLoading] = useState(true);

  useEffect(() => {
    fetchFeaturedTrainers();
  }, []);

  useEffect(() => {
    if (profile?.id) {
      fetchPlayerData();
      fetchFollowedTrainers();
    }
  }, [profile?.id]);

  const fetchFollowedTrainers = async () => {
    if (!profile?.id) return;
    setFollowingLoading(true);
    try {
      const { data: follows } = await supabase
        .from('trainer_followers')
        .select('id, trainer_id')
        .eq('player_id', profile.id)
        .limit(5);

      if (!follows || follows.length === 0) {
        setFollowedTrainers([]);
        setFollowingLoading(false);
        return;
      }

      const trainerIds = follows.map(f => f.trainer_id);
      const { data: trainers } = await supabase
        .from('trainer_profiles')
        .select('id, user_id')
        .in('id', trainerIds);

      if (!trainers) {
        setFollowedTrainers([]);
        setFollowingLoading(false);
        return;
      }

      const userIds = trainers.map(t => t.user_id);
      const { data: profiles } = await supabase
        .from('profiles_public')
        .select('user_id, full_name, avatar_url')
        .in('user_id', userIds);

      const profileMap = new Map(profiles?.map(p => [p.user_id, p]) || []);
      const trainerMap = new Map(trainers.map(t => [t.id, t]));

      const enriched: FollowedTrainer[] = follows.map(f => {
        const trainer = trainerMap.get(f.trainer_id);
        const p = trainer ? profileMap.get(trainer.user_id) : null;
        return {
          id: f.id,
          trainer_user_id: trainer?.user_id || '',
          full_name: p?.full_name || null,
          avatar_url: p?.avatar_url || null,
        };
      });

      setFollowedTrainers(enriched);
    } catch (error) {
      console.error('Error fetching followed trainers:', error);
    } finally {
      setFollowingLoading(false);
    }
  };

  const fetchPlayerData = async () => {
    if (!profile?.id) return;
    setStatsLoading(true);

    try {
      const now = new Date();

      // Fetch all bookings for this player
      const { data: bookings } = await supabase
        .from('bookings')
        .select(`
          id,
          status,
          availability_slots(
            start_time,
            trainer_id,
            trainer_profiles(
              user_id,
              profiles(full_name)
            )
          ),
          lessons(title, location)
        `)
        .eq('player_id', profile.id)
        .order('created_at', { ascending: false });

      if (bookings) {
        const confirmed = bookings.filter(b => b.status === 'confirmed');
        const upcoming = confirmed.filter(b => {
          const slot = b.availability_slots as any;
          return slot?.start_time && isAfter(new Date(slot.start_time), now);
        });
        const completed = confirmed.filter(b => {
          const slot = b.availability_slots as any;
          return slot?.start_time && !isAfter(new Date(slot.start_time), now);
        });

        setPlayerStats({
          totalBookings: bookings.length,
          completedLessons: completed.length,
          upcomingCount: upcoming.length,
        });

        // Format upcoming bookings for display (max 3)
        const upcomingFormatted: UpcomingBooking[] = upcoming.slice(0, 3).map(b => {
          const slot = b.availability_slots as any;
          const lesson = b.lessons as any;
          const trainerProfile = slot?.trainer_profiles as any;
          const trainerUserProfile = trainerProfile?.profiles as any;
          return {
            id: b.id,
            lessonTitle: lesson?.title || 'Training Session',
            trainerName: trainerUserProfile?.full_name || 'Trainer',
            startTime: new Date(slot.start_time),
            location: lesson?.location || null,
          };
        });

        setUpcomingBookings(upcomingFormatted);
      }
    } catch (error) {
      console.error('Error fetching player data:', error);
    } finally {
      setStatsLoading(false);
    }
  };

  const fetchFeaturedTrainers = async () => {
    const { data: trainerProfiles } = await supabase
      .from('trainer_profiles')
      .select('id, user_id, hourly_rate, experience_years, specializations, is_verified')
      .eq('is_verified', true)
      .limit(4);

    if (trainerProfiles && trainerProfiles.length > 0) {
      const userIds = trainerProfiles.map(t => t.user_id);
      const { data: profiles } = await supabase
        .from('profiles_public')
        .select('user_id, full_name, avatar_url, location')
        .in('user_id', userIds);

      const combined: FeaturedTrainer[] = trainerProfiles.map(trainer => ({
        ...trainer,
        profile: profiles?.find(p => p.user_id === trainer.user_id) || null
      }));

      setFeaturedTrainers(combined);
    } else {
      // If no verified trainers, get any trainers
      const { data: anyTrainers } = await supabase
        .from('trainer_profiles')
        .select('id, user_id, hourly_rate, experience_years, specializations, is_verified')
        .limit(4);

      if (anyTrainers && anyTrainers.length > 0) {
        const userIds = anyTrainers.map(t => t.user_id);
        const { data: profiles } = await supabase
          .from('profiles_public')
          .select('user_id, full_name, avatar_url, location')
          .in('user_id', userIds);

        const combined: FeaturedTrainer[] = anyTrainers.map(trainer => ({
          ...trainer,
          profile: profiles?.find(p => p.user_id === trainer.user_id) || null
        }));

        setFeaturedTrainers(combined);
      }
    }
    setLoadingTrainers(false);
  };

  const handleSignOut = async () => {
    const { error } = await signOut();
    if (error) {
      toast({
        title: 'Error',
        description: error.message,
        variant: 'destructive',
      });
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  const getTrainerInitials = (name: string | null) => {
    if (!name) return 'T';
    return name.split(' ').map(n => n[0]).join('').toUpperCase();
  };

  return (
    <main className="container mx-auto px-4 py-8">
      {/* Welcome Section */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">
          Welcome back, {profile?.full_name?.split(' ')[0] || 'Player'}! 👋
        </h1>
        <p className="text-muted-foreground">
          Find your next training session and improve your padel skills
        </p>
      </div>

        {/* Rating Card */}
        <Card className="mb-8 bg-gradient-to-r from-blue-500 to-blue-600 text-white border-0">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-blue-100 text-sm mb-1">Your Skill Rating</p>
                <div className="flex items-center gap-2">
                  <span className="text-4xl font-bold">
                    {profile?.skill_rating || '—'}
                  </span>
                  {profile?.skill_rating && (
                    <span className="text-xs bg-white/20 px-2 py-1 rounded">
                      {((profile as any)?.rating_system || 'knltb').toUpperCase()}
                    </span>
                  )}
                </div>
              </div>
              <TrendingUp className="h-12 w-12 text-blue-200" />
            </div>
            {!profile?.skill_rating && (
              <p className="text-blue-100 text-sm mt-3">
                Add your rating or ask a trainer to set your level
              </p>
            )}
          </CardContent>
        </Card>

        {/* Rating History Chart */}
        {profile?.id && (
          <div className="mb-8">
            <RatingHistoryChart
              profileId={profile.id}
              currentRating={profile.skill_rating ?? null}
              ratingSystem={(profile as any)?.rating_system || 'knltb'}
            />
          </div>
        )}

        {/* Stats Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-full bg-blue-100 dark:bg-blue-900">
                  <Calendar className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <p className="text-2xl font-bold">
                    {statsLoading ? '...' : playerStats.upcomingCount}
                  </p>
                  <p className="text-xs text-muted-foreground">Upcoming</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-full bg-green-100 dark:bg-green-900">
                  <Star className="h-4 w-4 text-green-600 dark:text-green-400" />
                </div>
                <div>
                  <p className="text-2xl font-bold">
                    {statsLoading ? '...' : playerStats.completedLessons}
                  </p>
                  <p className="text-xs text-muted-foreground">Completed</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-full bg-orange-100 dark:bg-orange-900">
                  <Clock className="h-4 w-4 text-orange-600 dark:text-orange-400" />
                </div>
                <div>
                  <p className="text-2xl font-bold">
                    {statsLoading ? '...' : playerStats.totalBookings}
                  </p>
                  <p className="text-xs text-muted-foreground">Total Bookings</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card 
            className="cursor-pointer hover:shadow-lg transition-shadow"
            onClick={() => navigate('/player/following')}
          >
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-full bg-purple-100 dark:bg-purple-900">
                  <Bell className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                </div>
                <div>
                  <p className="text-2xl font-bold">
                    {followingLoading ? '...' : followedTrainers.length}
                  </p>
                  <p className="text-xs text-muted-foreground">Following</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Upcoming Bookings */}
        {upcomingBookings.length > 0 && (
          <Card className="mb-8 border-primary/30 bg-primary/5">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Calendar className="h-5 w-5 text-primary" />
                  Next Up
                </CardTitle>
                <Button variant="ghost" size="sm" onClick={() => navigate('/bookings')} className="gap-1">
                  All Bookings <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {upcomingBookings.map((booking) => (
                <div key={booking.id} className="flex items-center gap-4 p-3 bg-background rounded-lg">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{booking.lessonTitle}</p>
                    <p className="text-sm text-muted-foreground">
                      with {booking.trainerName}
                      {booking.location && ` • ${booking.location}`}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-medium">{format(booking.startTime, 'EEE, MMM d')}</p>
                    <p className="text-sm text-muted-foreground">{format(booking.startTime, 'HH:mm')}</p>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Following Section */}
        {followedTrainers.length > 0 && (
          <Card className="mb-8">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Users className="h-5 w-5 text-primary" />
                  Following
                </CardTitle>
                <Button variant="ghost" size="sm" onClick={() => navigate('/player/following')} className="gap-1">
                  Manage <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-3">
                {followedTrainers.map((trainer) => (
                  <div
                    key={trainer.id}
                    className="flex items-center gap-2 p-2 rounded-lg bg-muted/50 cursor-pointer hover:bg-muted transition-colors"
                    onClick={() => navigate(localizePath(`/trainer/${trainer.trainer_user_id}`))}
                  >
                    <Avatar className="h-8 w-8">
                      <AvatarImage src={trainer.avatar_url || undefined} />
                      <AvatarFallback>{trainer.full_name?.[0] || 'T'}</AvatarFallback>
                    </Avatar>
                    <span className="text-sm font-medium">{trainer.full_name || 'Trainer'}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Quick Actions */}
        <div className="grid md:grid-cols-3 gap-4 mb-8">
          <Card 
            className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
            onClick={() => navigate(localizePath('/trainers'))}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-primary/10">
                  <Search className="h-5 w-5 text-primary" />
                </div>
                <CardTitle className="text-lg">Find Trainers</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <CardDescription>
                Browse all available trainers and find the perfect match for your skill level
              </CardDescription>
            </CardContent>
          </Card>

          <Card 
            className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
            onClick={() => navigate('/bookings')}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-green-500/10">
                  <Calendar className="h-5 w-5 text-green-600" />
                </div>
                <CardTitle className="text-lg">My Bookings</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <CardDescription>
                View your upcoming lessons and manage your training schedule
              </CardDescription>
            </CardContent>
          </Card>

          <Card 
            className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
            onClick={() => navigate('/profile/edit')}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-orange-500/10">
                  <User className="h-5 w-5 text-orange-600" />
                </div>
                <CardTitle className="text-lg">My Profile</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <CardDescription>
                Update your profile, add your KNLTB rating, and manage preferences
              </CardDescription>
            </CardContent>
          </Card>

          <Card 
            className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
            onClick={() => navigate('/settings/calendar')}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-500/10">
                  <CalendarSync className="h-5 w-5 text-blue-600" />
                </div>
                <CardTitle className="text-lg">Calendar Sync</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <CardDescription>
                Connect Google Calendar to sync your training sessions
              </CardDescription>
            </CardContent>
          </Card>
        </div>

        {/* Featured Trainers */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Star className="h-5 w-5 text-yellow-500" />
                  Featured Trainers
                </CardTitle>
                <CardDescription>
                  Top-rated trainers in your area
                </CardDescription>
              </div>
              <Button variant="ghost" onClick={() => navigate(localizePath('/trainers'))} className="gap-1">
                View All <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {loadingTrainers ? (
              <div className="flex justify-center py-8">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
              </div>
            ) : featuredTrainers.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <p>No trainers available yet</p>
                <p className="text-sm">Check back soon for new trainers!</p>
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {featuredTrainers.map((trainer) => (
                  <Card 
                    key={trainer.id}
                    className="cursor-pointer hover:shadow-md transition-all hover:border-primary/50"
                    onClick={() => navigate(localizePath(`/book/${trainer.id}`))}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-center gap-3 mb-3">
                        <Avatar className="h-12 w-12">
                          <AvatarImage src={trainer.profile?.avatar_url || undefined} />
                          <AvatarFallback>
                            {getTrainerInitials(trainer.profile?.full_name)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold truncate">
                            {trainer.profile?.full_name || 'Trainer'}
                          </p>
                          {trainer.profile?.location && (
                            <p className="text-xs text-muted-foreground flex items-center gap-1 truncate">
                              <MapPin className="h-3 w-3 shrink-0" />
                              {trainer.profile.location}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        {trainer.hourly_rate && (
                          <span className="text-sm font-semibold text-primary">
                            €{trainer.hourly_rate}/hr
                          </span>
                        )}
                        {trainer.is_verified && (
                          <Badge variant="secondary" className="text-xs">
                            <Star className="h-3 w-3 mr-1" />
                            Verified
                          </Badge>
                        )}
                      </div>
                      {trainer.specializations && trainer.specializations.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {trainer.specializations.slice(0, 2).map((spec, i) => (
                            <Badge key={i} variant="outline" className="text-xs">
                              {spec}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
  );
}