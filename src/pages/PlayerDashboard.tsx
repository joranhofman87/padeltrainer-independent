import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { signOut } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import { Search, Calendar, Star, User, LogOut, TrendingUp, MapPin, ChevronRight } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

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

export default function PlayerDashboard() {
  const { user, profile, role, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [featuredTrainers, setFeaturedTrainers] = useState<FeaturedTrainer[]>([]);
  const [loadingTrainers, setLoadingTrainers] = useState(true);

  useEffect(() => {
    if (!loading) {
      if (!user) {
        navigate('/auth');
      } else if (!role) {
        navigate('/select-role');
      } else if (role !== 'player') {
        navigate('/trainer');
      }
    }
  }, [user, role, loading, navigate]);

  useEffect(() => {
    fetchFeaturedTrainers();
  }, []);

  const fetchFeaturedTrainers = async () => {
    const { data: trainerProfiles } = await supabase
      .from('trainer_profiles')
      .select('id, user_id, hourly_rate, experience_years, specializations, is_verified')
      .eq('is_verified', true)
      .limit(4);

    if (trainerProfiles && trainerProfiles.length > 0) {
      const userIds = trainerProfiles.map(t => t.user_id);
      const { data: profiles } = await supabase
        .from('profiles')
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
          .from('profiles')
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
    } else {
      navigate('/auth');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  const initials = profile?.full_name
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase() || 'U';

  const getTrainerInitials = (name: string | null) => {
    if (!name) return 'T';
    return name.split(' ').map(n => n[0]).join('').toUpperCase();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-background to-blue-100/30 dark:from-blue-950/20 dark:via-background dark:to-blue-900/10">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🎾</span>
            <span className="font-bold text-xl">PadelMatch</span>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Avatar className="h-9 w-9">
                <AvatarImage src={profile?.avatar_url || undefined} />
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
              <span className="font-medium hidden sm:inline">{profile?.full_name || 'Player'}</span>
            </div>
            <Button variant="ghost" size="icon" onClick={handleSignOut}>
              <LogOut className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
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
                  {profile?.knltb_number && (
                    <span className="text-xs bg-white/20 px-2 py-1 rounded">
                      KNLTB
                    </span>
                  )}
                </div>
              </div>
              <TrendingUp className="h-12 w-12 text-blue-200" />
            </div>
            {!profile?.skill_rating && (
              <p className="text-blue-100 text-sm mt-3">
                Add your KNLTB rating or ask a trainer to set your level
              </p>
            )}
          </CardContent>
        </Card>

        {/* Quick Actions */}
        <div className="grid md:grid-cols-3 gap-4 mb-8">
          <Card 
            className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
            onClick={() => navigate('/trainers')}
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
              <Button variant="ghost" onClick={() => navigate('/trainers')} className="gap-1">
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
                    onClick={() => navigate(`/book/${trainer.id}`)}
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
    </div>
  );
}