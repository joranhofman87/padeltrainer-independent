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
import { ArrowLeft, Calendar, Clock, MapPin, User, Star, FileText, CalendarPlus } from 'lucide-react';
import { format, parseISO, isPast } from 'date-fns';
import { supabase } from '@/lib/supabaseClient';
import { cancelBooking } from '@/lib/lessons';
import { ReviewForm } from '@/components/reviews/ReviewForm';
import { getPlayerReview } from '@/lib/reviews';
import { PlayerInvoicesTab } from '@/components/player/PlayerInvoicesTab';
import { useTranslation } from 'react-i18next';
import { downloadIcsFile } from '@/lib/icsGenerator';

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
  const { t } = useTranslation('player');

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
        title: t('bookings.loadError'),
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

      // Cross-reference invoices to get accurate payment status for bookings
      const bookingIds = rawBookings.map(b => b.id);
      const { data: paidInvoices } = await supabase
        .from('invoices')
        .select('booking_ids, status, paid_at')
        .eq('player_id', profile!.id)
        .eq('status', 'paid');

      const paidBookingIds = new Set<string>();
      paidInvoices?.forEach(inv => {
        inv.booking_ids?.forEach((id: string) => paidBookingIds.add(id));
      });

      const bookingsWithDetails = await Promise.all(
        rawBookings.map(async (booking) => {
          const { data: review } = await getPlayerReview(booking.id);
          const trainerInfo = trainerInfoMap.get(booking.availability_slots?.trainer_id) || { name: 'Trainer', email: null, profileId: '' };
          // If invoice is paid but booking payment_status is still pending, override
          const effectivePaymentStatus = paidBookingIds.has(booking.id) && booking.payment_status !== 'paid'
            ? 'paid'
            : booking.payment_status;
          return {
            ...booking,
            payment_status: effectivePaymentStatus,
            status: effectivePaymentStatus === 'paid' && booking.status === 'pending' ? 'confirmed' : booking.status,
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
    if (!confirm(t('bookings.confirmCancel'))) return;

    const { error } = await cancelBooking(bookingId);
    if (error) {
      toast({
        title: t('bookings.cancelError'),
        variant: 'destructive',
      });
    } else {
      toast({ title: t('bookings.cancelSuccess') });
      fetchBookings();
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge variant="secondary" className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">{t('bookings.status.pendingPayment')}</Badge>;
      case 'pending_approval':
        return <Badge variant="secondary" className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">{t('bookings.status.awaitingApproval')}</Badge>;
      case 'confirmed':
        return <Badge className="bg-green-500">{t('bookings.status.confirmed')}</Badge>;
      case 'cancelled':
        return <Badge variant="destructive">{t('bookings.status.cancelled')}</Badge>;
      case 'completed':
        return <Badge variant="outline">{t('bookings.status.completed')}</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  const getPaymentBadge = (paymentStatus: string | null, bookingStatus: string) => {
    if (!paymentStatus) return null;
    switch (paymentStatus) {
      case 'paid':
        return <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 border-transparent">{t('bookings.payment.paid')}</Badge>;
      case 'waived':
        return <Badge variant="outline">{t('bookings.payment.waived')}</Badge>;
      case 'refunded':
        return <Badge variant="outline">{t('bookings.payment.refunded')}</Badge>;
      case 'pending':
        if (['confirmed', 'pending', 'pending_approval'].includes(bookingStatus)) {
          return <Badge className="bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200 border-transparent">{t('bookings.payment.unpaid')}</Badge>;
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

  const handleDownloadCalendar = (bookingsToExport: BookingWithDetails[]) => {
    const events = bookingsToExport
      .filter(b => b.status !== 'cancelled')
      .map(b => ({
        title: `Padel Training – ${b.trainerName}${b.availability_slots.cyclus_name ? ` (${b.availability_slots.cyclus_name})` : ''}`,
        startTime: b.availability_slots.start_time,
        endTime: b.availability_slots.end_time,
        location: b.availability_slots.locations?.name || undefined,
        description: `Coach: ${b.trainerName}`,
      }));
    if (events.length === 0) return;
    const cycleName = bookingsToExport[0]?.availability_slots.cyclus_name || 'training';
    downloadIcsFile(events, `${cycleName.replace(/\s+/g, '-').toLowerCase()}-sessions.ics`);
  };

  if (loading || loadingBookings) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <main className="container mx-auto px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('bookings.title')}</h1>
          <p className="text-muted-foreground">{t('bookings.subtitle')}</p>
        </div>
        {upcomingBookings.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => handleDownloadCalendar(upcomingBookings)}
          >
            <CalendarPlus className="h-4 w-4" />
            {t('bookings.addToCalendar', 'Add to Calendar')}
          </Button>
        )}
      </div>
      
      <Tabs defaultValue="upcoming">
        <TabsList className="mb-6">
          <TabsTrigger value="upcoming">
            {t('bookings.tabs.upcoming')} ({upcomingBookings.length})
          </TabsTrigger>
          <TabsTrigger value="past">
            {t('bookings.tabs.past')} ({pastBookings.length})
          </TabsTrigger>
          <TabsTrigger value="invoices" className="gap-1">
            <FileText className="h-4 w-4" />
            {t('bookings.invoices')}
          </TabsTrigger>
        </TabsList>

          <TabsContent value="upcoming">
            {upcomingBookings.length === 0 ? (
              <Card className="p-12 text-center">
                <div className="text-6xl mb-4">📅</div>
                <h3 className="text-xl font-semibold mb-2">{t('bookings.noUpcoming')}</h3>
                <p className="text-muted-foreground mb-6">
                  {t('bookings.findTrainerDescription')}
                </p>
                <Button onClick={() => navigate(localizePath('/trainers'))}>
                  {t('bookings.browseTrainers')}
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
                              {booking.availability_slots.cyclus_name || t('bookings.trainingSession')}
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
                              {t('bookings.coach')} {booking.trainerName}
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
                              {t('bookings.cancelBooking')}
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
                <p className="text-muted-foreground">{t('bookings.noPast')}</p>
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
                                {booking.availability_slots.cyclus_name || t('bookings.trainingSession')}
                              </h3>
                              {getStatusBadge(booking.status)}
                              {getPaymentBadge(booking.payment_status, booking.status)}
                              {booking.hasReview && (
                                <Badge variant="outline" className="bg-yellow-50 text-yellow-700 border-yellow-200">
                                  <Star className="h-3 w-3 mr-1 fill-yellow-500" />
                                  {t('bookings.reviewed')}
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
                                {t('bookings.coach')} {booking.trainerName}
                              </span>
                            </div>
                          </div>
                          {canReview && (
                            <Dialog open={reviewDialogOpen === booking.id} onOpenChange={(open) => setReviewDialogOpen(open ? booking.id : null)}>
                              <DialogTrigger asChild>
                                <Button variant="outline" className="gap-2">
                                  <Star className="h-4 w-4" />
                                  {t('bookings.leaveReview')}
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