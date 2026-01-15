import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Calendar, Clock, MapPin, User, Star } from 'lucide-react';
import { format, parseISO, isPast } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { cancelBooking } from '@/lib/lessons';
import { ReviewForm } from '@/components/reviews/ReviewForm';
import { getPlayerReview } from '@/lib/reviews';

interface BookingWithDetails {
  id: string;
  status: string;
  notes: string | null;
  created_at: string;
  availability_slots: {
    start_time: string;
    end_time: string;
    trainer_id: string;
    trainer_profiles: {
      id: string;
      user_id: string;
      profiles: {
        full_name: string;
        avatar_url: string | null;
      };
    };
  };
  lessons: {
    title: string;
    price: number;
    location: string | null;
  } | null;
  hasReview?: boolean;
}

export default function PlayerBookings() {
  const { user, profile, role, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [bookings, setBookings] = useState<BookingWithDetails[]>([]);
  const [loadingBookings, setLoadingBookings] = useState(true);
  const [reviewDialogOpen, setReviewDialogOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!loading) {
      if (!user) {
        navigate('/auth');
      } else if (role !== 'player') {
        navigate('/trainer');
      }
    }
  }, [user, role, loading, navigate]);

  useEffect(() => {
    if (user && profile?.id) {
      fetchBookings();
    }
  }, [user, profile]);

  const fetchBookings = async () => {
    const { data, error } = await supabase
      .from('bookings')
      .select(`
        id,
        status,
        notes,
        created_at,
        availability_slots(
          start_time,
          end_time,
          trainer_id,
          trainer_profiles(
            id,
            user_id,
            profiles(full_name, avatar_url)
          )
        ),
        lessons(title, price, location)
      `)
      .eq('player_id', profile!.id)
      .order('created_at', { ascending: false });

    if (data) {
      // Check which bookings have reviews
      const bookingsWithReviewStatus = await Promise.all(
        (data as unknown as BookingWithDetails[]).map(async (booking) => {
          const { data: review } = await getPlayerReview(booking.id);
          return { ...booking, hasReview: !!review };
        })
      );
      setBookings(bookingsWithReviewStatus);
    }
    if (error) {
      toast({
        title: 'Error',
        description: 'Failed to load bookings',
        variant: 'destructive',
      });
    }
    setLoadingBookings(false);
  };
    if (error) {
      toast({
        title: 'Error',
        description: 'Failed to load bookings',
        variant: 'destructive',
      });
    }
    setLoadingBookings(false);
  };

  const handleCancel = async (bookingId: string) => {
    if (!confirm('Are you sure you want to cancel this booking?')) return;

    const { error } = await cancelBooking(bookingId);
    if (error) {
      toast({
        title: 'Error',
        description: 'Failed to cancel booking',
        variant: 'destructive',
      });
    } else {
      toast({ title: 'Success', description: 'Booking cancelled' });
      fetchBookings();
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge variant="secondary">Pending</Badge>;
      case 'confirmed':
        return <Badge className="bg-green-500">Confirmed</Badge>;
      case 'cancelled':
        return <Badge variant="destructive">Cancelled</Badge>;
      case 'completed':
        return <Badge variant="outline">Completed</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  const upcomingBookings = bookings.filter(
    (b) => b.status !== 'cancelled' && !isPast(parseISO(b.availability_slots.start_time))
  );
  const pastBookings = bookings.filter(
    (b) => b.status === 'cancelled' || isPast(parseISO(b.availability_slots.start_time))
  );

  if (loading || loadingBookings) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-background to-blue-100/30 dark:from-blue-950/20 dark:via-background dark:to-blue-900/10">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/player')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-xl font-bold">My Bookings</h1>
            <p className="text-sm text-muted-foreground">View and manage your lesson bookings</p>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <Tabs defaultValue="upcoming">
          <TabsList className="mb-6">
            <TabsTrigger value="upcoming">
              Upcoming ({upcomingBookings.length})
            </TabsTrigger>
            <TabsTrigger value="past">
              Past ({pastBookings.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="upcoming">
            {upcomingBookings.length === 0 ? (
              <Card className="p-12 text-center">
                <div className="text-6xl mb-4">📅</div>
                <h3 className="text-xl font-semibold mb-2">No upcoming bookings</h3>
                <p className="text-muted-foreground mb-6">
                  Find a trainer and book your first lesson!
                </p>
                <Button onClick={() => navigate('/trainers')}>
                  Browse Trainers
                </Button>
              </Card>
            ) : (
              <div className="space-y-4">
                {upcomingBookings.map((booking) => (
                  <Card key={booking.id}>
                    <CardContent className="p-6">
                      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div className="space-y-2">
                          <div className="flex items-center gap-3">
                            <h3 className="text-lg font-semibold">
                              {booking.lessons?.title || 'Training Session'}
                            </h3>
                            {getStatusBadge(booking.status)}
                          </div>
                          <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                            <div className="flex items-center gap-1">
                              <Calendar className="h-4 w-4" />
                              {format(parseISO(booking.availability_slots.start_time), 'EEEE, MMM d, yyyy')}
                            </div>
                            <div className="flex items-center gap-1">
                              <Clock className="h-4 w-4" />
                              {format(parseISO(booking.availability_slots.start_time), 'HH:mm')} -
                              {format(parseISO(booking.availability_slots.end_time), 'HH:mm')}
                            </div>
                            {booking.lessons?.location && (
                              <div className="flex items-center gap-1">
                                <MapPin className="h-4 w-4" />
                                {booking.lessons.location}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <User className="h-4 w-4 text-muted-foreground" />
                            <span>
                              Coach {booking.availability_slots.trainer_profiles.profiles.full_name}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          {booking.lessons && (
                            <span className="text-xl font-bold">€{booking.lessons.price}</span>
                          )}
                          {booking.status !== 'cancelled' && (
                            <Button
                              variant="outline"
                              className="text-destructive"
                              onClick={() => handleCancel(booking.id)}
                            >
                              Cancel
                            </Button>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="past">
            {pastBookings.length === 0 ? (
              <Card className="p-8 text-center">
                <p className="text-muted-foreground">No past bookings</p>
              </Card>
            ) : (
              <div className="space-y-4">
                {pastBookings.map((booking) => {
                  const canReview = booking.status === 'completed' && !booking.hasReview;
                  
                  return (
                    <Card key={booking.id} className="opacity-90">
                      <CardContent className="p-6">
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                          <div className="space-y-2">
                            <div className="flex items-center gap-3">
                              <h3 className="text-lg font-semibold">
                                {booking.lessons?.title || 'Training Session'}
                              </h3>
                              {getStatusBadge(booking.status)}
                              {booking.hasReview && (
                                <Badge variant="outline" className="bg-yellow-50 text-yellow-700 border-yellow-200">
                                  <Star className="h-3 w-3 mr-1 fill-yellow-500" />
                                  Reviewed
                                </Badge>
                              )}
                            </div>
                            <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                              <div className="flex items-center gap-1">
                                <Calendar className="h-4 w-4" />
                                {format(parseISO(booking.availability_slots.start_time), 'EEEE, MMM d, yyyy')}
                              </div>
                              <div className="flex items-center gap-1">
                                <Clock className="h-4 w-4" />
                                {format(parseISO(booking.availability_slots.start_time), 'HH:mm')} -
                                {format(parseISO(booking.availability_slots.end_time), 'HH:mm')}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <User className="h-4 w-4 text-muted-foreground" />
                              <span>
                                Coach {booking.availability_slots.trainer_profiles.profiles.full_name}
                              </span>
                            </div>
                          </div>
                          {canReview && (
                            <Dialog open={reviewDialogOpen === booking.id} onOpenChange={(open) => setReviewDialogOpen(open ? booking.id : null)}>
                              <DialogTrigger asChild>
                                <Button variant="outline" className="gap-2">
                                  <Star className="h-4 w-4" />
                                  Leave Review
                                </Button>
                              </DialogTrigger>
                              <DialogContent className="sm:max-w-md">
                                <ReviewForm
                                  bookingId={booking.id}
                                  playerId={profile!.id}
                                  trainerId={booking.availability_slots.trainer_profiles.id}
                                  trainerName={booking.availability_slots.trainer_profiles.profiles.full_name}
                                  onSuccess={() => {
                                    setReviewDialogOpen(null);
                                    fetchBookings();
                                  }}
                                  onCancel={() => setReviewDialogOpen(null)}
                                />
                              </DialogContent>
                            </Dialog>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
