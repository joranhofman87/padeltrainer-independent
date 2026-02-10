import { useNavigate } from 'react-router-dom';
import { getMarketingPath } from '@/lib/domains';
import { useAuth } from '@/hooks/useAuth';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Search, Calendar, User, ChevronRight, Clock, Users, ArrowRight } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { format, isAfter } from 'date-fns';
import { RatingHistoryChart } from '@/components/player/RatingHistoryChart';
import { MyWaitingListEntries } from '@/components/waitingList';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface FollowedTrainer {
  id: string;
  trainer_id: string;
  trainer_slug: string | null;
  full_name: string | null;
  avatar_url: string | null;
}

interface UpcomingBooking {
  id: string;
  sessionTitle: string;
  trainerName: string;
  startTime: Date;
  location: string | null;
  status: string;
}

interface FollowedTrainerSlot {
  id: string;
  cyclusName: string | null;
  trainerName: string;
  trainerSlug: string | null;
  startTime: Date;
  location: string | null;
}

export default function PlayerDashboard() {
  const { profile, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [upcomingBookings, setUpcomingBookings] = useState<UpcomingBooking[]>([]);
  const [statsLoading, setStatsLoading] = useState(true);
  const [followedTrainers, setFollowedTrainers] = useState<FollowedTrainer[]>([]);
  const [followingLoading, setFollowingLoading] = useState(true);
  const [followedTrainerSlots, setFollowedTrainerSlots] = useState<FollowedTrainerSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(true);

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
        .limit(10);

      if (!follows || follows.length === 0) {
        setFollowedTrainers([]);
        setFollowingLoading(false);
        setSlotsLoading(false);
        return;
      }

      const trainerIds = follows.map(f => f.trainer_id);
      const { data: trainers } = await supabase
        .from('trainer_profiles')
        .select('id, user_id, slug')
        .in('id', trainerIds);

      if (!trainers) {
        setFollowedTrainers([]);
        setFollowingLoading(false);
        setSlotsLoading(false);
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
          trainer_id: trainer?.id || '',
          trainer_slug: trainer?.slug || null,
          full_name: p?.full_name || null,
          avatar_url: p?.avatar_url || null,
        };
      });

      setFollowedTrainers(enriched);
      setFollowingLoading(false);

      // Fetch open slots from followed trainers
      fetchFollowedTrainerSlots(trainerIds, trainers, profileMap);
    } catch (error) {
      console.error('Error fetching followed trainers:', error);
      setFollowingLoading(false);
      setSlotsLoading(false);
    }
  };

  const fetchFollowedTrainerSlots = async (
    trainerIds: string[],
    trainers: { id: string; user_id: string; slug: string | null }[],
    profileMap: Map<string, { user_id: string; full_name: string | null; avatar_url: string | null }>
  ) => {
    setSlotsLoading(true);
    try {
      const now = new Date().toISOString();
      const { data: slots } = await supabase
        .from('availability_slots')
        .select('id, cyclus_name, trainer_id, start_time, location_id, locations(name)')
        .in('trainer_id', trainerIds)
        .eq('is_public', true)
        .eq('is_marked_full', false)
        .gte('start_time', now)
        .order('start_time', { ascending: true })
        .limit(10);

      if (!slots || slots.length === 0) {
        setFollowedTrainerSlots([]);
        setSlotsLoading(false);
        return;
      }

      const trainerSlugMap = new Map(trainers.map(t => [t.id, t]));

      const enrichedSlots: FollowedTrainerSlot[] = slots.map(slot => {
        const trainer = trainerSlugMap.get(slot.trainer_id);
        const p = trainer ? profileMap.get(trainer.user_id) : null;
        return {
          id: slot.id,
          cyclusName: slot.cyclus_name,
          trainerName: p?.full_name || 'Trainer',
          trainerSlug: trainer?.slug || null,
          startTime: new Date(slot.start_time),
          location: (slot.locations as any)?.name || null,
        };
      });

      setFollowedTrainerSlots(enrichedSlots);
    } catch (error) {
      console.error('Error fetching followed trainer slots:', error);
    } finally {
      setSlotsLoading(false);
    }
  };

  const fetchPlayerData = async () => {
    if (!profile?.id) return;
    setStatsLoading(true);

    try {
      const now = new Date();

      const { data: bookings } = await supabase
        .from('bookings')
        .select(`
          id,
          status,
          availability_slots(
            start_time,
            trainer_id,
            cyclus_name,
            location_id,
            locations(name)
          )
        `)
        .eq('player_id', profile.id)
        .order('created_at', { ascending: false });

      if (bookings) {
        const active = bookings.filter(b => ['confirmed', 'pending', 'pending_approval'].includes(b.status));
        const upcoming = active.filter(b => {
          const slot = b.availability_slots as any;
          return slot?.start_time && isAfter(new Date(slot.start_time), now);
        });

        const upcomingSlice = upcoming.slice(0, 10);
        const trainerIds = [...new Set(upcomingSlice.map(b => (b.availability_slots as any)?.trainer_id).filter(Boolean))];

        let trainerNameMap = new Map<string, string>();
        if (trainerIds.length > 0) {
          const { data: trainers } = await supabase
            .from('trainer_profiles')
            .select('id, user_id')
            .in('id', trainerIds);
          if (trainers && trainers.length > 0) {
            const userIds = trainers.map(t => t.user_id);
            const { data: profiles } = await supabase
              .from('profiles_public')
              .select('user_id, full_name')
              .in('user_id', userIds);
            const pMap = new Map(profiles?.map(p => [p.user_id, p.full_name]) || []);
            trainers.forEach(t => {
              trainerNameMap.set(t.id, pMap.get(t.user_id) || 'Trainer');
            });
          }
        }

        const upcomingFormatted: UpcomingBooking[] = upcomingSlice.map(b => {
          const slot = b.availability_slots as any;
          return {
            id: b.id,
            sessionTitle: slot?.cyclus_name || 'Training Session',
            trainerName: trainerNameMap.get(slot?.trainer_id) || 'Trainer',
            startTime: new Date(slot.start_time),
            location: slot?.locations?.name || null,
            status: b.status,
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

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'confirmed':
        return <Badge variant="default">Confirmed</Badge>;
      case 'pending':
        return <Badge variant="secondary">Pending Payment</Badge>;
      case 'pending_approval':
        return <Badge variant="outline">Awaiting Approval</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  return (
    <main className="container mx-auto px-4 py-8 space-y-8">
      {/* Welcome Section */}
      <div>
        <h1 className="text-3xl font-bold mb-2">
          Welcome back, {profile?.full_name?.split(' ')[0] || 'Player'}! 👋
        </h1>
        <p className="text-muted-foreground">
          Find your next training session and improve your padel skills
        </p>
      </div>

      {/* Rating History Chart */}
      {profile?.id && (
        <RatingHistoryChart
          profileId={profile.id}
          currentRating={profile.skill_rating ?? null}
          ratingSystem={(profile as any)?.rating_system || 'knltb'}
        />
      )}

      {/* Quick Action Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card
          className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
          onClick={() => navigate(getMarketingPath('trainers'))}
        >
          <CardContent className="p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Search className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="font-semibold">Find Trainers</p>
                <p className="text-sm text-muted-foreground">Browse available trainers</p>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
          </CardContent>
        </Card>

        <Card
          className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
          onClick={() => navigate('/app/player/bookings')}
        >
          <CardContent className="p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-500/10">
                <Calendar className="h-5 w-5 text-green-600" />
              </div>
              <div>
                <p className="font-semibold">My Bookings</p>
                <p className="text-sm text-muted-foreground">View your schedule</p>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
          </CardContent>
        </Card>

        <Card
          className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
          onClick={() => navigate('/app/player/profile')}
        >
          <CardContent className="p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-orange-500/10">
                <User className="h-5 w-5 text-orange-600" />
              </div>
              <div>
                <p className="font-semibold">My Profile</p>
                <p className="text-sm text-muted-foreground">Update your details</p>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
          </CardContent>
        </Card>
      </div>

      {/* Activity Tables Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Upcoming Bookings */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <Calendar className="h-5 w-5 text-primary" />
                Upcoming Bookings
              </CardTitle>
              <Button variant="ghost" size="sm" onClick={() => navigate('/app/player/bookings')} className="gap-1">
                View all <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <div className="flex justify-center py-6">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary" />
              </div>
            ) : upcomingBookings.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">No upcoming bookings</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Session</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {upcomingBookings.map((booking) => (
                    <TableRow key={booking.id}>
                      <TableCell>
                        <div>
                          <p className="font-medium truncate">{booking.sessionTitle}</p>
                          <p className="text-xs text-muted-foreground">{booking.trainerName}</p>
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <div>
                          <p className="text-sm">{format(booking.startTime, 'EEE, MMM d')}</p>
                          <p className="text-xs text-muted-foreground">{format(booking.startTime, 'HH:mm')}</p>
                        </div>
                      </TableCell>
                      <TableCell>{getStatusBadge(booking.status)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Followed Trainers */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <Users className="h-5 w-5 text-primary" />
                Followed Trainers
              </CardTitle>
              <Button variant="ghost" size="sm" onClick={() => navigate(getMarketingPath('trainers'))} className="gap-1">
                All trainers <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {followingLoading ? (
              <div className="flex justify-center py-6">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary" />
              </div>
            ) : followedTrainers.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">Not following any trainers yet</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Trainer</TableHead>
                    <TableHead className="text-right">Profile</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {followedTrainers.map((trainer) => (
                    <TableRow key={trainer.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Avatar className="h-7 w-7">
                            <AvatarImage src={trainer.avatar_url || undefined} />
                            <AvatarFallback>{trainer.full_name?.[0] || 'T'}</AvatarFallback>
                          </Avatar>
                          <span className="font-medium text-sm">{trainer.full_name || 'Trainer'}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => navigate(getMarketingPath(`trainer/${trainer.trainer_slug || trainer.trainer_id}`))}
                        >
                          <ArrowRight className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Open Slots from Followed Trainers */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <Clock className="h-5 w-5 text-primary" />
                Open Slots
              </CardTitle>
              <Button variant="ghost" size="sm" onClick={() => navigate(getMarketingPath('trainers'))} className="gap-1">
                Browse <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <CardDescription>Available sessions from trainers you follow</CardDescription>
          </CardHeader>
          <CardContent>
            {slotsLoading ? (
              <div className="flex justify-center py-6">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary" />
              </div>
            ) : followedTrainerSlots.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">No open slots from followed trainers</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Session</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {followedTrainerSlots.map((slot) => (
                    <TableRow
                      key={slot.id}
                      className="cursor-pointer"
                      onClick={() => navigate(getMarketingPath(`trainer/${slot.trainerSlug || ''}`))}
                    >
                      <TableCell>
                        <div>
                          <p className="font-medium truncate">{slot.cyclusName || 'Open Session'}</p>
                          <p className="text-xs text-muted-foreground">{slot.trainerName}{slot.location ? ` • ${slot.location}` : ''}</p>
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <div>
                          <p className="text-sm">{format(slot.startTime, 'EEE, MMM d')}</p>
                          <p className="text-xs text-muted-foreground">{format(slot.startTime, 'HH:mm')}</p>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Waiting List */}
        <Card>
          <CardContent className="p-0">
            <MyWaitingListEntries />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
