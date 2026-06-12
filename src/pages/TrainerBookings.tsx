import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { useToast } from '@/hooks/use-toast';
import { logger } from '@/lib/logger';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import {
  Calendar,
  Clock,
  MapPin,
  CheckCircle2,
  XCircle,
  MessageSquare,
  CreditCard,
  RefreshCw,
  Bell
} from 'lucide-react';
import { format, parseISO, isPast } from 'date-fns';
import { supabase } from '@/lib/supabaseClient';
import { updateBookingStatus } from '@/lib/lessons';
import { syncInvoicesAfterBookingRemoval } from '@/lib/invoiceSync';
import { AppPage } from '@/components/ui/app-page';
import { EmptyState } from '@/components/ui/empty-state';
import { ListPageSkeleton } from '@/components/ui/list-page-skeleton';
import { StatTile } from '@/components/ui/stat-tile';
import { TrainerPageHeader } from '@/components/trainer/shell/TrainerPageHeader';

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
    price_per_session: number | null;
    cyclus_name: string | null;
    locations: { name: string } | null;
  };
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
  const { t } = useTranslation('trainer');
  const [bookings, setBookings] = useState<BookingWithDetails[]>([]);
  const [loadingBookings, setLoadingBookings] = useState(true);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancellingBooking, setCancellingBooking] = useState<BookingWithDetails | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [markCancelledId, setMarkCancelledId] = useState<string | null>(null);
  const [isMarkingCancelled, setIsMarkingCancelled] = useState(false);
  const [trainerId, setTrainerId] = useState<string | null>(null);

  useEffect(() => {
    if (!loading) {
      if (!user) {
        navigate('/app/auth');
      } else if (role !== 'trainer') {
        navigate('/app/player');
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

    setTrainerId(trainerProfile.id);

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
        availability_slots!inner(id, start_time, end_time, trainer_id, price_per_session, cyclus_name, location_id, locations(name)),
        player:profiles!bookings_player_id_fkey(id, full_name, email, avatar_url, skill_rating)
      `)
      .eq('availability_slots.trainer_id', trainerProfile.id)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('Error fetching bookings', error instanceof Error ? error : new Error(String(error)), { component: 'TrainerBookings' });
      toast({
        title: t('common:error'),
        description: t('manageBookings.loadError', 'Failed to load bookings'),
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
      toast({ title: t('common:error'), description: t('manageBookings.confirmError', 'Failed to confirm booking'), variant: 'destructive' });
    } else {
      toast({ title: t('manageBookings.bookingConfirmed'), description: t('manageBookings.bookingConfirmedDescription') });
      fetchBookings();
    }
  };

  const openCancelDialog = (booking: BookingWithDetails) => {
    setCancellingBooking(booking);
    setCancelDialogOpen(true);
  };

  // Invoices reference bookings via a booking_ids array (no FK), so a
  // cancelled booking would keep being billed. Recalculate unpaid invoices;
  // paid invoices are never rewritten — warn the trainer instead.
  const syncInvoicesForCancelledBookings = async (bookingIds: string[]) => {
    try {
      const { skippedPaidInvoiceNumbers } = await syncInvoicesAfterBookingRemoval(bookingIds);
      if (skippedPaidInvoiceNumbers.length > 0) {
        toast({
          title: t('manageBookings.paidInvoiceNotUpdated', 'Paid invoice not updated'),
          description: t(
            'manageBookings.paidInvoiceNotUpdatedDescription',
            'Invoice {{numbers}} is already paid and was left unchanged. Please review it manually.',
            { numbers: skippedPaidInvoiceNumbers.join(', ') },
          ),
        });
      }
    } catch (err) {
      logger.error('Invoice sync failed after booking cancellation', err instanceof Error ? err : new Error(String(err)), { component: 'TrainerBookings' });
      toast({
        title: t('common:error'),
        description: t('manageBookings.invoiceSyncFailed', 'The booking was cancelled, but a linked invoice could not be updated. Please check the invoice.'),
        variant: 'destructive',
      });
    }
  };

  const handleCancelAndClose = async () => {
    if (!cancellingBooking) return;
    setIsCancelling(true);

    const { error } = await updateBookingStatus(cancellingBooking.id, 'cancelled');
    if (error) {
      toast({ title: t('common:error'), description: t('manageBookings.cancelError', 'Failed to cancel booking'), variant: 'destructive' });
    } else {
      await syncInvoicesForCancelledBookings([cancellingBooking.id]);
      toast({ title: t('manageBookings.lessonCancelled', 'Booking Cancelled'), description: t('manageBookings.lessonCancelledDescription', 'The booking has been cancelled and the slot is now closed.') });
      fetchBookings();
    }

    setIsCancelling(false);
    setCancelDialogOpen(false);
    setCancellingBooking(null);
  };

  const handleCancelAndReopen = async () => {
    if (!cancellingBooking || !trainerId) return;
    setIsCancelling(true);
    
    try {
      // Cancel the booking
      const { error } = await updateBookingStatus(cancellingBooking.id, 'cancelled');
      if (error) throw error;

      await syncInvoicesForCancelledBookings([cancellingBooking.id]);

      // Notify followers about the reopened slot with authentication
      const slotDate = format(parseISO(cancellingBooking.availability_slots.start_time), 'EEE, MMM d');
      const slotTime = format(parseISO(cancellingBooking.availability_slots.start_time), 'HH:mm');
      
      const { data: { session } } = await supabase.auth.getSession();
      await supabase.functions.invoke('notify-followers', {
        body: {
          slot_count: 1,
          date_range: slotDate,
          single_slot: {
            date: slotDate,
            time: slotTime,
          },
        },
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
        },
      });

      toast({ 
        title: t('manageBookings.slotReopened'), 
        description: t('manageBookings.slotReopenedDescription')
      });
      fetchBookings();
    } catch (err: any) {
      toast({ title: t('common:error'), description: getFriendlyErrorMessage(err, t('manageBookings.cancelError', 'Failed to cancel and reopen')), variant: 'destructive' });
    }
    
    setIsCancelling(false);
    setCancelDialogOpen(false);
    setCancellingBooking(null);
  };

  const handleCancel = async (bookingId: string) => {
    // Find the booking and open dialog
    const booking = bookings.find(b => b.id === bookingId);
    if (booking) {
      openCancelDialog(booking);
    }
  };

  const handleMarkCancelled = (bookingId: string) => {
    setMarkCancelledId(bookingId);
  };

  const confirmMarkCancelled = async () => {
    if (!markCancelledId || isMarkingCancelled) return;
    setIsMarkingCancelled(true);

    // Update both status and payment_status
    const { error } = await supabase
      .from('bookings')
      .update({ status: 'cancelled', payment_status: 'waived' })
      .eq('id', markCancelledId);

    if (error) {
      toast({ title: t('common:error'), description: t('manageBookings.cancelError', 'Failed to mark as cancelled'), variant: 'destructive' });
    } else {
      await syncInvoicesForCancelledBookings([markCancelledId]);
      toast({ title: t('manageBookings.lessonCancelled'), description: t('manageBookings.lessonCancelledDescription') });
      fetchBookings();
    }
    setIsMarkingCancelled(false);
    setMarkCancelledId(null);
  };

  const handleComplete = async (bookingId: string) => {
    const { error } = await updateBookingStatus(bookingId, 'completed');
    if (error) {
      toast({ title: t('common:error'), description: t('manageBookings.completeError', 'Failed to complete booking'), variant: 'destructive' });
    } else {
      toast({ title: t('manageBookings.lessonCompleted'), description: t('manageBookings.lessonCompletedDescription') });
      fetchBookings();
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge variant="secondary" className="bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300">{t('manageBookings.statusPending')}</Badge>;
      case 'confirmed':
        return <Badge variant="secondary" className="bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300">{t('manageBookings.statusConfirmed')}</Badge>;
      case 'cancelled':
        return <Badge variant="destructive">{t('manageBookings.statusCancelled')}</Badge>;
      case 'completed':
        return <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">{t('manageBookings.statusCompleted')}</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const getPaymentBadge = (paymentStatus: string, paymentTiming: string, bookingStatus: string) => {
    if (paymentStatus === 'paid') {
      return <Badge variant="outline" className="border-green-300 text-green-600"><CreditCard className="h-3 w-3 mr-1" />{t('manageBookings.paymentPaid')}</Badge>;
    }
    if (paymentStatus === 'waived') {
      return <Badge variant="outline" className="border-gray-300 text-gray-600">{t('manageBookings.paymentWaived')}</Badge>;
    }
    if (paymentTiming === 'after') {
      if (bookingStatus === 'cancelled') {
        return <Badge variant="outline" className="border-gray-300 text-gray-600">{t('manageBookings.paymentNoCharge')}</Badge>;
      }
      return <Badge variant="outline" className="border-orange-300 text-orange-600">{t('manageBookings.paymentDueAfter')}</Badge>;
    }
    return <Badge variant="outline" className="border-yellow-300 text-yellow-600">{t('manageBookings.paymentPending')}</Badge>;
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
      <AppPage>
        <ListPageSkeleton />
      </AppPage>
    );
  }

  return (
    <AppPage className="space-y-4">
        <TrainerPageHeader
          title={t('manageBookings.title')}
          description={t('manageBookings.subtitle')}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatTile
            label={t('manageBookings.statusPending')}
            value={String(pendingBookings.length)}
            icon={Bell}
            highlight={pendingBookings.length > 0}
          />
          <StatTile
            label={t('manageBookings.upcoming')}
            value={String(upcomingBookings.length)}
            icon={Calendar}
          />
          <StatTile
            label={t('manageBookings.statusCompleted')}
            value={String(pastBookings.filter((b) => b.status === 'completed').length)}
            icon={CheckCircle2}
          />
        </div>

        <Tabs defaultValue="pending" className="space-y-4">
          <TabsList>
            <TabsTrigger value="pending" className="gap-2">
              {t('manageBookings.pending')}
              {pendingBookings.length > 0 && (
                <Badge variant="destructive" className="h-5 w-5 p-0 justify-center">{pendingBookings.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="upcoming">{t('manageBookings.upcoming')}</TabsTrigger>
            <TabsTrigger value="past">{t('manageBookings.past')}</TabsTrigger>
          </TabsList>

          <TabsContent value="pending" className="space-y-4">
            {pendingBookings.length === 0 ? (
              <Card className="overflow-hidden border-border/80 shadow-sm">
                <EmptyState
                  icon={CheckCircle2}
                  title={t('manageBookings.allCaughtUp')}
                  description={t('manageBookings.noPendingBookings')}
                />
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
              <Card className="overflow-hidden border-border/80 shadow-sm">
                <EmptyState
                  icon={Calendar}
                  title={t('manageBookings.noUpcomingLessons')}
                  description={t('manageBookings.confirmedWillAppear')}
                />
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
              <Card className="overflow-hidden border-border/80 shadow-sm">
                <EmptyState
                  icon={Clock}
                  title={t('manageBookings.noPastLessons')}
                  description={t('manageBookings.pastWillAppear')}
                />
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

      {/* Cancel Dialog */}
      <Dialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('manageBookings.cancelBooking')}</DialogTitle>
            <DialogDescription>
              {t('manageBookings.cancelDescription')}
            </DialogDescription>
          </DialogHeader>
          
          {cancellingBooking && (
            <div className="py-4">
              <div className="flex items-center gap-3 p-3 bg-muted rounded-lg mb-4">
                <Calendar className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="font-medium">
                    {format(parseISO(cancellingBooking.availability_slots.start_time), 'EEEE, MMMM d')}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {format(parseISO(cancellingBooking.availability_slots.start_time), 'HH:mm')} - {format(parseISO(cancellingBooking.availability_slots.end_time), 'HH:mm')}
                  </p>
                </div>
              </div>
              
              <div className="space-y-3">
                <Button
                  variant="outline"
                  className="w-full justify-start gap-3 h-auto py-3"
                  onClick={handleCancelAndClose}
                  disabled={isCancelling}
                  aria-label={t('manageBookings.cancelAndClose')}
                >
                  <XCircle className="h-5 w-5 text-destructive" />
                   <div className="text-left">
                     <p className="font-medium">{t('manageBookings.cancelAndClose')}</p>
                     <p className="text-xs text-muted-foreground">
                       {t('manageBookings.cancelAndCloseDescription')}
                     </p>
                   </div>
                </Button>
                
                <Button
                  variant="outline"
                  className="w-full justify-start gap-3 h-auto py-3 border-green-300 hover:bg-green-50 dark:hover:bg-green-950"
                  onClick={handleCancelAndReopen}
                  disabled={isCancelling}
                  aria-label={t('manageBookings.cancelAndReopen')}
                >
                  <RefreshCw className="h-5 w-5 text-green-600" />
                   <div className="text-left">
                     <p className="font-medium text-green-700 dark:text-green-400">{t('manageBookings.cancelAndReopen')}</p>
                     <p className="text-xs text-muted-foreground">
                       <Bell className="h-3 w-3 inline mr-1" />
                       {t('manageBookings.cancelAndReopenDescription')}
                     </p>
                  </div>
                </Button>
              </div>
            </div>
          )}
          
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCancelDialogOpen(false)} disabled={isCancelling}>
              {t('manageBookings.keepBooking')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mark-cancelled confirmation */}
      <ConfirmDeleteDialog
        open={!!markCancelledId}
        onOpenChange={(next) => { if (!next) setMarkCancelledId(null); }}
        title={t('manageBookings.markCancelledConfirmTitle', 'Mark lesson as cancelled?')}
        description={t('manageBookings.markCancelledConfirm')}
        confirmLabel={t('manageBookings.markCancelledConfirmAction', 'Mark as cancelled')}
        cancelLabel={t('manageBookings.keepBooking')}
        loading={isMarkingCancelled}
        onConfirm={() => { void confirmMarkCancelled(); }}
      />
    </AppPage>
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
  onMarkCancelled: _onMarkCancelled,
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
              <AvatarImage src={booking.player?.avatar_url || undefined} alt={booking.player?.full_name || ''} />
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
              {getPaymentBadge(booking.payment_status, 'upfront', booking.status)}
            </div>
            {booking.availability_slots.cyclus_name && (
              <p className="font-medium">{booking.availability_slots.cyclus_name}</p>
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
              {booking.availability_slots.locations?.name && (
                <span className="flex items-center gap-1">
                  <MapPin className="h-4 w-4" />
                  {booking.availability_slots.locations.name}
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
            {booking.availability_slots.price_per_session != null && (
              <p className="text-xl font-bold text-primary">€{booking.availability_slots.price_per_session}</p>
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