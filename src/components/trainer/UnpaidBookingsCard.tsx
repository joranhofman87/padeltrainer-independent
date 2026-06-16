import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Euro, Send, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { flushOnMobileCardClass } from "@/components/ui/surface";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { sendEmail } from "@/lib/email";
import { formatCurrency } from "@/lib/format";
import { logger } from "@/lib/logger";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchUnpaidBookingsData,
  unpaidBookingsQueryOptions,
  buildUnpaidReminderSessionsHtml,
  markUnpaidBookingsPaid,
  setUnpaidBookingsReminderSent,
  type UnpaidBooking,
} from "@/lib/unpaidBookings";

export const UNPAID_BOOKINGS_PREVIEW_LIMIT = 10;

interface UnpaidBookingsCardProps {
  trainerId?: string | null;
  academyId?: string | null;
}

function obligationSubtitle(booking: UnpaidBooking, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (booking.isCycleGroup) {
    const sessionsLabel = t("unpaidBookings.sessionCount", { count: booking.sessionCount });
    return `${sessionsLabel} · ${booking.sessionDate}`;
  }
  return `${booking.sessionDate} · ${booking.sessionTime}`;
}

export function getVisibleUnpaidBookings(
  bookings: UnpaidBooking[],
  expanded: boolean,
  limit = UNPAID_BOOKINGS_PREVIEW_LIMIT,
): UnpaidBooking[] {
  if (expanded || bookings.length <= limit) return bookings;
  return bookings.slice(0, limit);
}

export function UnpaidBookingsCard({ trainerId, academyId }: UnpaidBookingsCardProps) {
  const { t } = useTranslation("trainer");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sendingIds, setSendingIds] = useState<Set<string>>(new Set());
  const [markingIds, setMarkingIds] = useState<Set<string>>(new Set());

  const queryKey = ['unpaid-bookings', trainerId, academyId];

  const { data: bookings = [], isLoading, isError } = useQuery({
    queryKey,
    queryFn: () => fetchUnpaidBookingsData(trainerId, academyId),
    enabled: !!(trainerId || academyId),
    ...unpaidBookingsQueryOptions,
  });

  const hasMoreThanPreview = bookings.length > UNPAID_BOOKINGS_PREVIEW_LIMIT;
  const visibleBookings = getVisibleUnpaidBookings(bookings, expanded);
  const visibleIdSet = new Set(visibleBookings.map((b) => b.id));
  const allVisibleSelected =
    visibleBookings.length > 0 && visibleBookings.every((b) => selected.has(b.id));
  const visibleSelectedCount = visibleBookings.filter((b) => selected.has(b.id)).length;

  const removeObligationsFromCache = (groupKeys: Set<string>) => {
    queryClient.setQueryData<UnpaidBooking[]>(queryKey, (old) =>
      old?.filter((b) => !groupKeys.has(b.id)) || [],
    );
  };

  const handleMarkPaid = async (booking: UnpaidBooking) => {
    setMarkingIds((prev) => new Set(prev).add(booking.id));
    try {
      const { error } = await markUnpaidBookingsPaid(booking.bookingIds);
      if (error) throw error;

      removeObligationsFromCache(new Set([booking.id]));
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(booking.id);
        return next;
      });

      toast({ title: t("unpaidBookings.markPaid") });
    } catch (error) {
      logger.error("Error marking as paid", error as Error, { component: "UnpaidBookingsCard" });
    } finally {
      setMarkingIds((prev) => {
        const next = new Set(prev);
        next.delete(booking.id);
        return next;
      });
    }
  };

  const handleSendReminder = async (booking: UnpaidBooking) => {
    if (!booking.playerEmail) return;

    setSendingIds((prev) => new Set(prev).add(booking.id));
    try {
      await sendEmail("payment_reminder", booking.playerEmail, {
        playerName: booking.playerName,
        trainerName: booking.trainerName,
        totalAmount: booking.amount,
        unpaidSessions: buildUnpaidReminderSessionsHtml(booking),
      });

      const { error } = await setUnpaidBookingsReminderSent(booking.bookingIds);
      if (error) throw error;

      const sentAt = new Date().toISOString();
      queryClient.setQueryData<UnpaidBooking[]>(queryKey, (old) =>
        old?.map((b) =>
          b.id === booking.id ? { ...b, reminderSentAt: sentAt } : b,
        ) || [],
      );

      toast({ title: t("unpaidBookings.reminderSentSuccess") });
    } catch (error) {
      logger.error("Error sending reminder", error as Error, { component: "UnpaidBookingsCard" });
    } finally {
      setSendingIds((prev) => {
        const next = new Set(prev);
        next.delete(booking.id);
        return next;
      });
    }
  };

  const handleBulkReminder = async () => {
    const selectedObligations = bookings.filter(
      (b) => selected.has(b.id) && visibleIdSet.has(b.id) && b.playerEmail,
    );
    const allGroupKeys = new Set(selectedObligations.map((b) => b.id));
    setSendingIds(allGroupKeys);

    let sentCount = 0;
    for (const booking of selectedObligations) {
      try {
        await sendEmail("payment_reminder", booking.playerEmail, {
          playerName: booking.playerName,
          trainerName: booking.trainerName,
          totalAmount: booking.amount,
          unpaidSessions: buildUnpaidReminderSessionsHtml(booking),
        });

        await setUnpaidBookingsReminderSent(booking.bookingIds);
        sentCount++;
      } catch (error) {
        logger.error("Error in bulk reminder", error as Error, { component: "UnpaidBookingsCard" });
      }
    }

    toast({
      title: t("unpaidBookings.bulkReminderSentSuccess", { count: sentCount }),
    });

    setSelected(new Set());
    setSendingIds(new Set());
    queryClient.invalidateQueries({ queryKey });
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const visibleIds = visibleBookings.map((b) => b.id);
    if (allVisibleSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        visibleIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setSelected((prev) => new Set([...prev, ...visibleIds]));
    }
  };

  const handleToggleExpanded = () => {
    if (expanded) {
      const previewIds = new Set(
        bookings.slice(0, UNPAID_BOOKINGS_PREVIEW_LIMIT).map((b) => b.id),
      );
      setSelected((prev) => new Set([...prev].filter((id) => previewIds.has(id))));
    }
    setExpanded((prev) => !prev);
  };

  const totalOutstanding = bookings.reduce((sum, b) => sum + b.amount, 0);

  if (isLoading || isError) return null;
  if (bookings.length === 0) return null;

  return (
    <Card className={flushOnMobileCardClass("mb-6 border-border/60 shadow-sm")}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Euro className="h-5 w-5 text-orange-500" />
            {t("unpaidBookings.title")}
            <Badge variant="destructive" className="ml-1">
              {bookings.length}
            </Badge>
          </CardTitle>
          <div className="text-sm font-semibold text-orange-600 dark:text-orange-400">
            {t("unpaidBookings.totalOutstanding")}: {formatCurrency(totalOutstanding)}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center justify-between pb-2 border-b">
          <div className="flex items-center gap-2">
            <Checkbox
              checked={allVisibleSelected}
              onCheckedChange={toggleSelectAll}
            />
            <span className="text-sm text-muted-foreground">
              {t("unpaidBookings.selectAll")}
            </span>
          </div>
          {visibleSelectedCount > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleBulkReminder}
              disabled={sendingIds.size > 0}
            >
              {sendingIds.size > 0 ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Send className="h-3 w-3 mr-1" />
              )}
              {t("unpaidBookings.sendBulkReminder")} ({visibleSelectedCount})
            </Button>
          )}
        </div>

        {visibleBookings.map((booking) => (
          <div
            key={booking.id}
            data-testid="unpaid-obligation-row"
            className="flex items-center gap-3 p-2 rounded-md hover:bg-muted/50"
          >
            <Checkbox
              checked={selected.has(booking.id)}
              onCheckedChange={() => toggleSelect(booking.id)}
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm truncate">
                  {booking.playerName}
                </span>
                {booking.isCycleGroup && booking.cyclusName && (
                  <Badge variant="secondary" className="text-xs">
                    {booking.cyclusName}
                  </Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {obligationSubtitle(booking, t)}
                <span className="ml-2 font-medium text-foreground">
                  {formatCurrency(booking.amount)}
                </span>
              </div>
              {booking.reminderSentAt && (
                <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                  <AlertCircle className="h-3 w-3" />
                  {t("unpaidBookings.lastReminder")}:{" "}
                  {formatDistanceToNow(new Date(booking.reminderSentAt), {
                    addSuffix: true,
                  })}
                </div>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handleSendReminder(booking)}
                disabled={sendingIds.has(booking.id)}
                title={t("unpaidBookings.sendReminder")}
              >
                {sendingIds.has(booking.id) ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Send className="h-3 w-3" />
                )}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handleMarkPaid(booking)}
                disabled={markingIds.has(booking.id)}
                title={t("unpaidBookings.markPaid")}
                className="text-green-600 hover:text-green-700 hover:bg-green-50 dark:hover:bg-green-900/20"
              >
                {markingIds.has(booking.id) ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-3 w-3" />
                )}
              </Button>
            </div>
          </div>
        ))}

        {hasMoreThanPreview && (
          <div className="flex flex-col items-center gap-1 pt-2 border-t">
            {!expanded && (
              <p className="text-xs text-muted-foreground">
                {t("unpaidBookings.showingCount", {
                  shown: UNPAID_BOOKINGS_PREVIEW_LIMIT,
                  total: bookings.length,
                })}
              </p>
            )}
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-sm"
              onClick={handleToggleExpanded}
              data-testid="unpaid-bookings-expand-toggle"
            >
              {expanded ? t("unpaidBookings.showLess") : t("unpaidBookings.showAll")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
