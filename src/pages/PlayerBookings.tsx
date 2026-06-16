import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { BookingStatusBadge } from '@/components/player/BookingStatusBadge';
import { useToast } from '@/hooks/use-toast';
import { Calendar, Clock, MapPin, User, Star, FileText, CalendarPlus, CalendarX } from 'lucide-react';
import { isPast, parseISO } from 'date-fns';
import { formatDate } from '@/lib/format';
import { cancelBooking } from '@/lib/lessons';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { ReviewForm } from '@/components/reviews/ReviewForm';
import { getReviewedBookingIds } from '@/lib/reviews';
import { fetchPlayerBookings, type PlayerBooking } from '@/lib/playerBookings';
import { PlayerInvoicesTab } from '@/components/player/PlayerInvoicesTab';
import { useTranslation } from 'react-i18next';
import { downloadIcsFile } from '@/lib/icsGenerator';
import { PlayerSessionReport } from '@/components/attendance/PlayerSessionReport';
import { AppPage } from '@/components/ui/app-page';
import { PageHeader } from '@/components/ui/page-header';
import { surfaceCardClass } from '@/components/ui/app-page';
import { flushOnMobileCardClass } from '@/components/ui/surface';

interface BookingWithDetails extends PlayerBooking {
  hasReview: boolean;
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
  const [cancelTarget, setCancelTarget] = useState<BookingWithDetails | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const fetchBookings = useCallback(async () => {
    if (!profile?.id) return;
    try {
      const list = await fetchPlayerBookings(profile.id);
      // Batched review lookup (kept here so the shared fetch stays UI-agnostic):
      // one IN query instead of one request per booking.
      const reviewedIds = await getReviewedBookingIds(list.map((b) => b.id));
      const withReviews = list.map((booking) => ({
        ...booking,
        hasReview: reviewedIds.has(booking.id),
      }));
      setBookings(withReviews);
    } catch {
      toast({
        title: t('bookings.loadError'),
        variant: 'destructive',
      });
    } finally {
      setLoadingBookings(false);
    }
  }, [profile?.id, toast, t]);

  useEffect(() => {
    if (user && profile?.id) {
      fetchBookings();
    }
  }, [user, profile?.id, fetchBookings]);

  const isPaidBooking = (booking: BookingWithDetails) =>
    booking.payment_status === 'paid' || !!booking.paid_externally;

  const handleConfirmCancel = async () => {
    if (!cancelTarget) return;
    setCancelling(true);
    const { error } = await cancelBooking(cancelTarget.id);
    setCancelling(false);
    if (error) {
      toast({
        title: t('bookings.cancelError'),
        description: getFriendlyErrorMessage(error, t('bookings.cancelErrorRetry', 'Probeer het later opnieuw of neem contact op met je trainer.')),
        variant: 'destructive',
      });
    } else {
      setCancelTarget(null);
      toast({ title: t('bookings.cancelSuccess') });
      fetchBookings();
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

  // Guard against a null slot (e.g. a booked slot a trainer later marked private)
  // so the page never crashes on a missing start_time.
  const upcomingBookings = bookings.filter(
    (b) => b.status !== 'cancelled' && b.start_time && !isPast(parseISO(b.start_time))
  );
  const pastBookings = bookings.filter(
    (b) => b.status === 'cancelled' || !b.start_time || isPast(parseISO(b.start_time))
  );

  const handleDownloadCalendar = (bookingsToExport: BookingWithDetails[]) => {
    const events = bookingsToExport
      .filter(b => b.status !== 'cancelled' && b.start_time)
      .map(b => ({
        title: `Padel Training – ${b.trainer_name}${b.cyclus_name ? ` (${b.cyclus_name})` : ''}`,
        startTime: b.start_time!,
        endTime: b.end_time ?? b.start_time!,
        location: b.location_name || undefined,
        description: `Coach: ${b.trainer_name}`,
      }));
    if (events.length === 0) return;
    const cycleName = bookingsToExport[0]?.cyclus_name || 'training';
    downloadIcsFile(events, `${cycleName.replace(/\s+/g, '-').toLowerCase()}-sessions.ics`);
  };

  if (loading || loadingBookings) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    );
  }

  const calendarAction =
    upcomingBookings.length > 0 ? (
      <Button
        variant="outline"
        size="sm"
        className="gap-2"
        onClick={() => handleDownloadCalendar(upcomingBookings)}
      >
        <CalendarPlus className="h-4 w-4" />
        {t('bookings.addToCalendar', 'Add to Calendar')}
      </Button>
    ) : undefined;

  return (
    <AppPage as="main" data-testid="page-player-bookings">
      <PageHeader
        title={t('bookings.title')}
        description={t('bookings.subtitle')}
        actions={calendarAction}
      />

      <p className="-mt-2 mb-4 text-sm text-muted-foreground">{t('bookings.pageGuide')}</p>

      <Tabs defaultValue="upcoming">
        <TabsList className="mb-4 flex w-full flex-wrap justify-start gap-1">
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
              <Card className={surfaceCardClass()}>
                <EmptyState
                  icon={Calendar}
                  title={t('bookings.noUpcoming')}
                  description={t('bookings.findTrainerDescription')}
                  action={
                    <Button onClick={() => navigate(localizePath('/trainers'))}>
                      {t('bookings.browseTrainers')}
                    </Button>
                  }
                />
              </Card>
            ) : (
              <div className="space-y-4">
                {upcomingBookings.map((booking) => (
                  <Card key={booking.id} className={flushOnMobileCardClass()}>
                    <CardContent className="p-5 sm:p-6">
                      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div className="space-y-2">
                          <div className="flex items-center gap-3">
                            <h3 className="text-lg font-semibold">
                              {booking.cyclus_name || t('bookings.trainingSession')}
                            </h3>
                            <BookingStatusBadge status={booking.status} />
                            {getPaymentBadge(booking.payment_status, booking.status)}
                          </div>
                          <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                            <div className="flex items-center gap-1">
                              <Calendar className="h-4 w-4" />
                              {formatDate(booking.start_time!, 'EEEE d MMM yyyy')}
                            </div>
                            <div className="flex items-center gap-1">
                              <Clock className="h-4 w-4" />
                              {formatDate(booking.start_time!, 'HH:mm')} -
                              {formatDate(booking.end_time ?? booking.start_time!, 'HH:mm')}
                            </div>
                            {booking.location_name && (
                              <div className="flex items-center gap-1">
                                <MapPin className="h-4 w-4" />
                                {booking.location_name}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <User className="h-4 w-4 text-muted-foreground" />
                            <span>
                              {t('bookings.coach')} {booking.trainer_name}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          {booking.price_per_session != null && (
                            <span className="text-xl font-bold">€{booking.price_per_session}</span>
                          )}
                          {booking.status !== 'cancelled' && (
                            <Button
                              variant="outline"
                              className="text-destructive"
                              onClick={() => setCancelTarget(booking)}
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
              <Card className={surfaceCardClass()}>
                <EmptyState
                  icon={CalendarX}
                  title={t('bookings.noPast')}
                  description={t('bookings.noPastDescription')}
                />
              </Card>
            ) : (
              <div className="space-y-4">
                {pastBookings.map((booking) => {
                  const canReview = booking.status === 'completed' && !booking.hasReview;

                  return (
                    <Card key={booking.id} className={flushOnMobileCardClass('opacity-95')}>
                      <CardContent className="p-6">
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                          <div className="space-y-2">
                            <div className="flex items-center gap-3">
                              <h3 className="text-lg font-semibold">
                                {booking.cyclus_name || t('bookings.trainingSession')}
                              </h3>
                              <BookingStatusBadge status={booking.status} />
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
                                {booking.start_time && formatDate(booking.start_time, 'EEEE d MMM yyyy')}
                              </div>
                              {booking.start_time && (
                                <div className="flex items-center gap-1">
                                  <Clock className="h-4 w-4" />
                                  {formatDate(booking.start_time, 'HH:mm')} -
                                  {formatDate(booking.end_time ?? booking.start_time, 'HH:mm')}
                                </div>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <User className="h-4 w-4 text-muted-foreground" />
                              <span>
                                {t('bookings.coach')} {booking.trainer_name}
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
                                  trainerId={booking.trainer_id || ''}
                                  trainerName={booking.trainer_name}
                                  playerName={profile!.full_name || undefined}
                                  lessonTitle={booking.cyclus_name || undefined}
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
                        {/* Attendance + self-notes for past non-cancelled bookings */}
                        {booking.status !== 'cancelled' && booking.start_time && isPast(parseISO(booking.start_time)) && (
                          <PlayerSessionReport slotId={booking.slot_id} className="mt-3 border-t pt-3" />
                        )}
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

      {/* Cancel booking confirmation */}
      <ConfirmDeleteDialog
        open={!!cancelTarget}
        onOpenChange={(next) => { if (!next) setCancelTarget(null); }}
        title={t('bookings.cancelDialog.title', 'Boeking annuleren?')}
        description={
          cancelTarget && isPaidBooking(cancelTarget)
            ? t('bookings.cancelDialog.paidWarning', 'Deze les is al betaald. Annuleren geeft niet automatisch je geld terug — neem contact op met je trainer om een eventuele terugbetaling af te stemmen.')
            : t('bookings.confirmCancel')
        }
        confirmLabel={t('bookings.cancelBooking')}
        cancelLabel={t('bookings.cancelDialog.keep', 'Boeking behouden')}
        loading={cancelling}
        onConfirm={handleConfirmCancel}
      />
    </AppPage>
  );
}
