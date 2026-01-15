import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Search, MapPin, Star, ArrowLeft, Filter } from 'lucide-react';

interface TrainerWithProfile {
  user_id: string;
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
  } | null;
}

export default function Trainers() {
  const [trainers, setTrainers] = useState<TrainerWithProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [locationFilter, setLocationFilter] = useState<string>('all');
  const [locations, setLocations] = useState<string[]>([]);
  const navigate = useNavigate();
  const { user } = useAuth();

  useEffect(() => {
    fetchTrainers();
  }, []);

  const fetchTrainers = async () => {
    setLoading(true);
    
    // Fetch trainer profiles with their general profiles
    const { data: trainerProfiles, error: trainerError } = await supabase
      .from('trainer_profiles')
      .select('user_id, hourly_rate, experience_years, certifications, specializations, is_verified');
    
    if (trainerError) {
      console.error('Error fetching trainers:', trainerError);
      setLoading(false);
      return;
    }

    // Fetch profiles for all trainers
    const userIds = trainerProfiles.map(t => t.user_id);
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('user_id, full_name, avatar_url, bio, location')
      .in('user_id', userIds);

    if (profilesError) {
      console.error('Error fetching profiles:', profilesError);
      setLoading(false);
      return;
    }

    // Combine trainer profiles with general profiles
    const combined: TrainerWithProfile[] = trainerProfiles.map(trainer => ({
      ...trainer,
      profile: profiles.find(p => p.user_id === trainer.user_id) || null
    }));

    setTrainers(combined);
    
    // Extract unique locations for filter
    const uniqueLocations = [...new Set(profiles
      .map(p => p.location)
      .filter((loc): loc is string => Boolean(loc))
    )];
    setLocations(uniqueLocations);
    
    setLoading(false);
  };

  const filteredTrainers = trainers.filter(trainer => {
    const matchesSearch = !searchQuery || 
      trainer.profile?.full_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      trainer.profile?.bio?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      trainer.specializations?.some(s => s.toLowerCase().includes(searchQuery.toLowerCase()));
    
    const matchesLocation = locationFilter === 'all' || 
      trainer.profile?.location === locationFilter;
    
    return matchesSearch && matchesLocation;
  });

  const getInitials = (name: string | null) => {
    if (!name) return 'T';
    return name.split(' ').map(n => n[0]).join('').toUpperCase();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-background to-blue-100/30 dark:from-blue-950/20 dark:via-background dark:to-blue-900/10">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate('/player')}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <span className="text-2xl">🎾</span>
            <span className="font-bold text-xl">Find Trainers</span>
          </div>
          {!user && (
            <Button onClick={() => navigate('/auth')}>Sign In</Button>
          )}
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        {/* Search and Filters */}
        <div className="mb-8 space-y-4">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search trainers by name, specialty..."
                className="pl-10"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <Select value={locationFilter} onValueChange={setLocationFilter}>
              <SelectTrigger className="w-full sm:w-[200px]">
                <Filter className="h-4 w-4 mr-2" />
                <SelectValue placeholder="All Locations" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Locations</SelectItem>
                {locations.map(loc => (
                  <SelectItem key={loc} value={loc}>{loc}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-sm text-muted-foreground">
            {filteredTrainers.length} trainer{filteredTrainers.length !== 1 ? 's' : ''} found
          </p>
        </div>

        {/* Trainers Grid */}
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        ) : filteredTrainers.length === 0 ? (
          <Card className="text-center py-12">
            <CardContent>
              <p className="text-muted-foreground mb-4">No trainers found</p>
              {searchQuery || locationFilter !== 'all' ? (
                <Button variant="outline" onClick={() => { setSearchQuery(''); setLocationFilter('all'); }}>
                  Clear Filters
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Be the first trainer to join PadelMatch!
                </p>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredTrainers.map((trainer) => (
              <Card 
                key={trainer.user_id} 
                className="cursor-pointer hover:shadow-lg transition-all hover:border-primary/50"
                onClick={() => navigate(`/trainer/${trainer.user_id}`)}
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
                      <div className="flex items-center gap-2">
                        <CardTitle className="text-lg truncate">
                          {trainer.profile?.full_name || 'Trainer'}
                        </CardTitle>
                        {trainer.is_verified && (
                          <Badge variant="secondary" className="shrink-0">
                            <Star className="h-3 w-3 mr-1" />
                            Verified
                          </Badge>
                        )}
                      </div>
                      {trainer.profile?.location && (
                        <CardDescription className="flex items-center gap-1 mt-1">
                          <MapPin className="h-3 w-3" />
                          {trainer.profile.location}
                        </CardDescription>
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
                    {trainer.experience_years && (
                      <span className="text-muted-foreground">
                        {trainer.experience_years} years exp.
                      </span>
                    )}
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
      </main>
    </div>
  );
}
