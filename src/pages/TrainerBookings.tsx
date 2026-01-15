import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useToast } from '@/hooks/use-toast';
import { 
  ArrowLeft, 
  Calendar, 
  Clock, 
  User, 
  MapPin, 
  Euro,
  CheckCircle2,
  XCircle,
  MessageSquare,
  CreditCard
} from 'lucide-react';
import { format, parseISO, isPast } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { updateBookingStatus } from '@/lib/lessons';

interface BookingWithDetails {
  id: string;
  status: string;
  notes: string | null;
  payment_status: string;
  payment_amount: number | null;
  created_at: string;
  availability_slots: {
    id: string;
    start_time: string;
    end_time: string;
  };
  lessons: {
    id: string;
    title: string;
    price: number;
    duration_minutes: number;
    location: string | null;
    payment_timing: string;
  } | null;
  player: {
    id: string;
    full_name: string | null;
    email: string | null;
    avatar_url: string | null;
    skill_rating: number | null;
  } | null;
}

export default function TrainerBookings() {
  const navigate = useNavigate();
  const { user, role, loading } = useAuth();
  const { toast } = useToast();
  
  const [bookings, setBookings] = useState<BookingWithDetails[]>([]);
  const [loadingBookings, setLoadingBookings] = useState(true);

  useEffect(() => {
    if (!loading) {
      if (!user) {
        navigate('/auth');
      } else if (role !== 'trainer') {
        navigate('/player');
      }
    }
  }, [user, role, loading, navigate]);

  useEffect(() => {
    if (user && role === 'trainer') {
      fetchBookings();
    }
  }, [user, role]);

  const fetchBookings = async () => {
    // First get trainer profile
    const { data: trainerProfile } = await supabase
      .from('trainer_profiles')
      .select('id')
      .eq('user_id', user!.id)
      .single();

    if (!trainerProfile) {
      setLoadingBookings(false);
      return;
    }

    // Fetch bookings with all related data
    const { data, error } = await supabase
      .from('bookings')
      .select(`
        id,
        status,
        notes,
        payment_status,
        payment_amount,
        created_at,
        availability_slots!inner(id, start_time, end_time, trainer_id),
        lessons(id, title, price, duration_minutes, location, payment_timing),
        player:profiles!bookings_player_id_fkey(id, full_name, email, avatar_url, skill_rating)
      `)
      .eq('availability_slots.trainer_id', trainerProfile.id)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching bookings:', error);
      toast({
        title: 'Error',
        description: 'Failed to load bookings',
        variant: 'destructive',
      });
    } else {
      setBookings((data as any) || []);
    }
    setLoadingBookings(false);
  };

  const handleConfirm = async (bookingId: string) => {
    const { error } = await updateBookingStatus(bookingId, 'confirmed');
    if (error) {
      toast({ title: 'Error', description: 'Failed to confirm booking', variant: 'destructive' });
    } else {
      toast({ title: 'Booking Confirmed', description: 'The player has been notified' });
      fetchBookings();
    }
  };

  const handleCancel = async (bookingId: string) => {
    if (!confirm('Are you sure you want to cancel this booking?')) return;
    
    const { error } = await updateBookingStatus(bookingId, 'cancelled');
    if (error) {
      toast({ title: 'Error', description: 'Failed to cancel booking', variant: 'destructive' });
    } else {
      toast({ title: 'Booking Cancelled', description: 'The booking has been cancelled' });
      fetchBookings();
    }
  };

  const handleMarkCancelled = async (bookingId: string) => {
    if (!confirm('Mark this lesson as cancelled? Payment will be waived.')) return;
    
    // Update both status and payment_status
    const { error } = await supabase
      .from('bookings')
      .update({ status: 'cancelled', payment_status: 'waived' })
      .eq('id', bookingId);
      
    if (error) {
      toast({ title: 'Error', description: 'Failed to mark as cancelled', variant: 'destructive' });
    } else {
      toast({ title: 'Lesson Cancelled', description: 'Payment has been waived for this lesson' });
      fetchBookings();
    }
  };

  const handleComplete = async (bookingId: string) => {
    const { error } = await updateBookingStatus(bookingId, 'completed');
    if (error) {
      toast({ title: 'Error', description: 'Failed to complete booking', variant: 'destructive' });
    } else {
      toast({ title: 'Lesson Completed', description: 'The lesson has been marked as completed' });
      fetchBookings();
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge variant="secondary" className="bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300">Pending</Badge>;
      case 'confirmed':
        return <Badge variant="secondary" className="bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300">Confirmed</Badge>;
      case 'cancelled':
        return <Badge variant="destructive">Cancelled</Badge>;
      case 'completed':
        return <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">Completed</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const getPaymentBadge = (paymentStatus: string, paymentTiming: string, bookingStatus: string) => {
    if (paymentStatus === 'paid') {
      return <Badge variant="outline" className="border-green-300 text-green-600"><CreditCard className="h-3 w-3 mr-1" />Paid</Badge>;
    }
    if (paymentStatus === 'waived') {
      return <Badge variant="outline" className="border-gray-300 text-gray-600">Waived</Badge>;
    }
    if (paymentTiming === 'after') {
      if (bookingStatus === 'cancelled') {
        return <Badge variant="outline" className="border-gray-300 text-gray-600">No Charge</Badge>;
      }
      return <Badge variant="outline" className="border-orange-300 text-orange-600">Due After</Badge>;
    }
    return <Badge variant="outline" className="border-yellow-300 text-yellow-600">Payment Pending</Badge>;
  };

  // Filter bookings
  const pendingBookings = bookings.filter(b => b.status === 'pending');
  const upcomingBookings = bookings.filter(b => 
    (b.status === 'confirmed') && 
    !isPast(parseISO(b.availability_slots.end_time))
  );
  const pastBookings = bookings.filter(b => 
    b.status === 'completed' || 
    b.status === 'cancelled' ||
    (b.status === 'confirmed' && isPast(parseISO(b.availability_slots.end_time)))
  );

  if (loading || loadingBookings) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate('/trainer')}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-xl font-bold">Manage Bookings</h1>
              <p className="text-sm text-muted-foreground">View and manage player bookings</p>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-3xl font-bold text-yellow-600">{pendingBookings.length}</p>
              <p className="text-sm text-muted-foreground">Pending</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-3xl font-bold text-blue-600">{upcomingBookings.length}</p>
              <p className="text-sm text-muted-foreground">Upcoming</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-3xl font-bold text-green-600">{pastBookings.filter(b => b.status === 'completed').length}</p>
              <p className="text-sm text-muted-foreground">Completed</p>
            </CardContent>
          </Card>
        </div>

        <Tabs defaultValue="pending" className="space-y-4">
          <TabsList>
            <TabsTrigger value="pending" className="gap-2">
              Pending
              {pendingBookings.length > 0 && (
                <Badge variant="destructive" className="h-5 w-5 p-0 justify-center">{pendingBookings.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
            <TabsTrigger value="past">Past</TabsTrigger>
          </TabsList>

          <TabsContent value="pending" className="space-y-4">
            {pendingBookings.length === 0 ? (
              <Card className="p-8 text-center">
                <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-4" />
                <h3 className="font-semibold text-lg mb-2">All caught up!</h3>
                <p className="text-muted-foreground">No pending bookings to review</p>
              </Card>
            ) : (
              pendingBookings.map(booking => (
                <BookingCard 
                  key={booking.id} 
                  booking={booking} 
                  onConfirm={handleConfirm}
                  onCancel={handleCancel}
                  getStatusBadge={getStatusBadge}
                  getPaymentBadge={getPaymentBadge}
                  showActions
                />
              ))
            )}
          </TabsContent>

          <TabsContent value="upcoming" className="space-y-4">
            {upcomingBookings.length === 0 ? (
              <Card className="p-8 text-center">
                <Calendar className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="font-semibold text-lg mb-2">No upcoming lessons</h3>
                <p className="text-muted-foreground">Confirmed bookings will appear here</p>
              </Card>
            ) : (
              upcomingBookings.map(booking => (
                <BookingCard 
                  key={booking.id} 
                  booking={booking}
                  onComplete={handleComplete}
                  onCancel={handleCancel}
                  onMarkCancelled={handleMarkCancelled}
                  getStatusBadge={getStatusBadge}
                  getPaymentBadge={getPaymentBadge}
                  showCompleteAction
                />
              ))
            )}
          </TabsContent>

          <TabsContent value="past" className="space-y-4">
            {pastBookings.length === 0 ? (
              <Card className="p-8 text-center">
                <Clock className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="font-semibold text-lg mb-2">No past lessons</h3>
                <p className="text-muted-foreground">Completed and cancelled bookings will appear here</p>
              </Card>
            ) : (
              pastBookings.map(booking => (
                <BookingCard 
                  key={booking.id} 
                  booking={booking}
                  getStatusBadge={getStatusBadge}
                  getPaymentBadge={getPaymentBadge}
                  isPast
                />
              ))
            )}
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

interface BookingCardProps {
  booking: BookingWithDetails;
  onConfirm?: (id: string) => void;
  onCancel?: (id: string) => void;
  onComplete?: (id: string) => void;
  onMarkCancelled?: (id: string) => void;
  getStatusBadge: (status: string) => React.ReactNode;
  getPaymentBadge: (paymentStatus: string, paymentTiming: string, bookingStatus: string) => React.ReactNode;
  showActions?: boolean;
  showCompleteAction?: boolean;
  isPast?: boolean;
}

function BookingCard({ 
  booking, 
  onConfirm, 
  onCancel,
  onComplete,
  onMarkCancelled,
  getStatusBadge,
  getPaymentBadge,
  showActions,
  showCompleteAction,
  isPast 
}: BookingCardProps) {
  const playerInitials = booking.player?.full_name
    ?.split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase() || 'P';

  return (
    <Card className={isPast ? 'opacity-75' : ''}>
      <CardContent className="p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          {/* Player Info */}
          <div className="flex items-center gap-4">
            <Avatar className="h-12 w-12">
              <AvatarImage src={booking.player?.avatar_url || undefined} />
              <AvatarFallback>{playerInitials}</AvatarFallback>
            </Avatar>
            <div>
              <p className="font-semibold">{booking.player?.full_name || 'Player'}</p>
              <p className="text-sm text-muted-foreground">{booking.player?.email}</p>
              {booking.player?.skill_rating && (
                <p className="text-xs text-muted-foreground">Rating: {booking.player.skill_rating}</p>
              )}
            </div>
          </div>

          <div className="flex-1 md:px-6">
            <div className="flex items-center gap-2 mb-2">
              {getStatusBadge(booking.status)}
              {getPaymentBadge(booking.payment_status, booking.lessons?.payment_timing || 'upfront', booking.status)}
            </div>
            {booking.lessons && (
              <p className="font-medium">{booking.lessons.title}</p>
            )}
            <div className="flex flex-wrap gap-4 text-sm text-muted-foreground mt-1">
              <span className="flex items-center gap-1">
                <Calendar className="h-4 w-4" />
                {format(parseISO(booking.availability_slots.start_time), 'EEE, MMM d')}
              </span>
              <span className="flex items-center gap-1">
                <Clock className="h-4 w-4" />
                {format(parseISO(booking.availability_slots.start_time), 'HH:mm')} - {format(parseISO(booking.availability_slots.end_time), 'HH:mm')}
              </span>
              {booking.lessons?.location && (
                <span className="flex items-center gap-1">
                  <MapPin className="h-4 w-4" />
                  {booking.lessons.location}
                </span>
              )}
            </div>
            {booking.notes && (
              <div className="mt-2 p-2 bg-muted rounded text-sm flex items-start gap-2">
                <MessageSquare className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{booking.notes}</span>
              </div>
            )}
          </div>

          {/* Price & Actions */}
          <div className="flex flex-col items-end gap-2">
            {booking.lessons && (
              <p className="text-xl font-bold text-primary">€{booking.lessons.price}</p>
            )}
            
            {showActions && (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => onCancel?.(booking.id)}>
                  <XCircle className="h-4 w-4 mr-1" />
                  Decline
                </Button>
                <Button size="sm" onClick={() => onConfirm?.(booking.id)}>
                  <CheckCircle2 className="h-4 w-4 mr-1" />
                  Confirm
                </Button>
              </div>
            )}

            {showCompleteAction && (
              <div className="flex gap-2">
                {booking.lessons?.payment_timing === 'after' && (
                  <Button size="sm" variant="destructive" onClick={() => onMarkCancelled?.(booking.id)}>
                    <XCircle className="h-4 w-4 mr-1" />
                    Cancelled
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => onCancel?.(booking.id)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={() => onComplete?.(booking.id)}>
                  <CheckCircle2 className="h-4 w-4 mr-1" />
                  Complete
                </Button>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}