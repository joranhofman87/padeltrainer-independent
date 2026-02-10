import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Calendar, Clock, MapPin, User, Star, FileText } from 'lucide-react';
import { format, parseISO, isPast } from 'date-fns';
import { supabase } from '@/lib/supabaseClient';
import { cancelBooking } from '@/lib/lessons';
import { ReviewForm } from '@/components/reviews/ReviewForm';
import { getPlayerReview } from '@/lib/reviews';
import { PlayerInvoicesTab } from '@/components/player/PlayerInvoicesTab';

interface BookingWithDetails {
  id: string;
  status: string;
  payment_status: string | null;
  notes: string | null;
  created_at: string;
  availability_slots: {
    start_time: string;
    end_time: string;
    trainer_id: string;
    price_per_session: number | null;
    cyclus_name: string | null;
    locations: { name: string } | null;
  };
  hasReview?: boolean;
  trainerName: string;
  trainerEmail: string | null;
  trainerProfileId: string;
}

export default function PlayerBookings() {
  const { user, profile, loading } = useAuth();
  const navigate = useNavigate();
  const localizePath = useLocalizedPathFn();
  const { toast } = useToast();

  const [bookings, setBookings] = useState<BookingWithDetails[]>([]);
  const [loadingBookings, setLoadingBookings] = useState(true);
  const [reviewDialogOpen, setReviewDialogOpen] = useState<string | null>(null);

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
        payment_status,
        notes,
        created_at,
        availability_slots(
          start_time,
          end_time,
          trainer_id,
          price_per_session,
          cyclus_name,
          location_id,
          locations(name)
        )
      `)
      .eq('player_id', profile!.id)
      .order('created_at', { ascending: false });

    if (error) {
      toast({
        title: 'Error',
        description: 'Failed to load bookings',
        variant: 'destructive',
      });
      setLoadingBookings(false);
      return;
    }

    if (data) {
      const rawBookings = data as unknown as Array<{
        id: string; status: string; payment_status: string | null; notes: string | null; created_at: string;
        availability_slots: { start_time: string; end_time: string; trainer_id: string; price_per_session: number | null; cyclus_name: string | null; locations: { name: string } | null };
      }>;

      // Enrich with trainer info
      const trainerIds = [...new Set(rawBookings.map(b => b.availability_slots?.trainer_id).filter(Boolean))];
      let trainerInfoMap = new Map<string, { name: string; email: string | null; profileId: string }>();

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
          const profileMap = new Map(profiles?.map(p => [p.user_id, p]) || []);
          trainers.forEach(t => {
            const p = profileMap.get(t.user_id);
            trainerInfoMap.set(t.id, {
              name: p?.full_name || 'Trainer',
              email: null,
              profileId: t.id,
            });
          });
        }
      }

      // Check which bookings have reviews
      const bookingsWithDetails = await Promise.all(
        rawBookings.map(async (booking) => {
          const { data: review } = await getPlayerReview(booking.id);
          const trainerInfo = trainerInfoMap.get(booking.availability_slots?.trainer_id) || { name: 'Trainer', email: null, profileId: '' };
          return {
            ...booking,
            hasReview: !!review,
            trainerName: trainerInfo.name,
            trainerEmail: trainerInfo.email,
            trainerProfileId: trainerInfo.profileId,
          } as BookingWithDetails;
        })
      );
      setBookings(bookingsWithDetails);
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
        return <Badge variant="secondary" className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">Pending Payment</Badge>;
      case 'pending_approval':
        return <Badge variant="secondary" className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">Awaiting Approval</Badge>;
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

  const getPaymentBadge = (paymentStatus: string | null, bookingStatus: string) => {
    if (!paymentStatus) return null;
    switch (paymentStatus) {
      case 'paid':
        return <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 border-transparent">Paid</Badge>;
      case 'waived':
        return <Badge variant="outline">Waived</Badge>;
      case 'refunded':
        return <Badge variant="outline">Refunded</Badge>;
      case 'pending':
        if (['confirmed', 'pending', 'pending_approval'].includes(bookingStatus)) {
          return <Badge className="bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200 border-transparent">Unpaid</Badge>;
        }
        return null;
      default:
        return null;
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
    <main className="container mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">My Bookings</h1>
        <p className="text-muted-foreground">View and manage your lesson bookings</p>
      </div>
      
      <Tabs defaultValue="upcoming">
        <TabsList className="mb-6">
          <TabsTrigger value="upcoming">
            Upcoming ({upcomingBookings.length})
          </TabsTrigger>
          <TabsTrigger value="past">
            Past ({pastBookings.length})
          </TabsTrigger>
          <TabsTrigger value="invoices" className="gap-1">
            <FileText className="h-4 w-4" />
            Facturen
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
                <Button onClick={() => navigate(localizePath('/trainers'))}>
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
                              {booking.availability_slots.cyclus_name || 'Training Session'}
                            </h3>
                            {getStatusBadge(booking.status)}
                            {getPaymentBadge(booking.payment_status, booking.status)}
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
                            {booking.availability_slots.locations?.name && (
                              <div className="flex items-center gap-1">
                                <MapPin className="h-4 w-4" />
                                {booking.availability_slots.locations.name}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <User className="h-4 w-4 text-muted-foreground" />
                            <span>
                              Coach {booking.trainerName}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          {booking.availability_slots.price_per_session != null && (
                            <span className="text-xl font-bold">€{booking.availability_slots.price_per_session}</span>
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
                                {booking.availability_slots.cyclus_name || 'Training Session'}
                              </h3>
                              {getStatusBadge(booking.status)}
                              {getPaymentBadge(booking.payment_status, booking.status)}
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
                                Coach {booking.trainerName}
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
                                  trainerId={booking.trainerProfileId}
                                  trainerName={booking.trainerName}
                                  trainerEmail={booking.trainerEmail || undefined}
                                  playerName={profile!.full_name || undefined}
                                  lessonTitle={booking.availability_slots.cyclus_name || undefined}
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

          <TabsContent value="invoices">
            {profile?.id && <PlayerInvoicesTab profileId={profile.id} />}
          </TabsContent>
      </Tabs>
    </main>
  );
}
