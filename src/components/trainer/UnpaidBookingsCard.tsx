import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Euro, Send, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/lib/supabaseClient";
import { sendEmail } from "@/lib/email";
import { logger } from "@/lib/logger";

interface UnpaidBooking {
  id: string;
  slotId: string;
  playerName: string;
  playerEmail: string;
  playerId: string | null;
  guestPlayerId: string | null;
  sessionDate: string;
  sessionTime: string;
  amount: number | null;
  cyclusName: string | null;
  reminderSentAt: string | null;
  trainerName: string;
}

interface UnpaidBookingsCardProps {
  trainerId?: string | null;
  academyId?: string | null;
}

export function UnpaidBookingsCard({ trainerId, academyId }: UnpaidBookingsCardProps) {
  const { t } = useTranslation("trainer");
  const { toast } = useToast();
  const [bookings, setBookings] = useState<UnpaidBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sendingIds, setSendingIds] = useState<Set<string>>(new Set());
  const [markingIds, setMarkingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchUnpaidBookings();
  }, [trainerId, academyId]);

  const fetchUnpaidBookings = async () => {
    setLoading(true);
    try {
      let trainerIds: string[] = [];

      if (academyId) {
        const { data: academyTrainers } = await supabase
          .from("academy_trainers")
          .select("trainer_profile_id")
          .eq("academy_profile_id", academyId)
          .eq("status", "active");
        trainerIds = academyTrainers?.map((t) => t.trainer_profile_id) || [];
      } else if (trainerId) {
        trainerIds = [trainerId];
      }

      if (trainerIds.length === 0) {
        setBookings([]);
        setLoading(false);
        return;
      }

      const { data, error } = await supabase
        .from("bookings")
        .select(`
          id,
          slot_id,
          payment_status,
          payment_amount,
          reminder_sent_at,
          player_id,
          guest_player_id,
          profiles:player_id (full_name, email),
          guest_players:guest_player_id (full_name, email),
          availability_slots!inner (
            start_time,
            end_time,
            trainer_id,
            cyclus_name,
            price_per_session,
            trainer_profiles:trainer_id (
              id,
              profiles:user_id (full_name)
            )
          )
        `)
        .in("availability_slots.trainer_id", trainerIds)
        .eq("payment_status", "pending")
        .in("status", ["confirmed", "pending"])
        .gte("availability_slots.start_time", new Date().toISOString())
        .order("availability_slots(start_time)", { ascending: true });

      if (error) throw error;

      const mapped: UnpaidBooking[] = (data || []).map((b: any) => {
        const slot = b.availability_slots;
        const profile = b.profiles as { full_name: string | null; email: string | null } | null;
        const guest = b.guest_players as { full_name: string | null; email: string | null } | null;
        const trainerProfile = slot?.trainer_profiles as any;
        const trainerProfileData = trainerProfile?.profiles as { full_name: string | null } | null;

        return {
          id: b.id,
          slotId: b.slot_id,
          playerName: profile?.full_name || guest?.full_name || "Unknown",
          playerEmail: profile?.email || guest?.email || "",
          playerId: b.player_id,
          guestPlayerId: b.guest_player_id,
          sessionDate: format(new Date(slot.start_time), "dd MMM yyyy"),
          sessionTime: `${format(new Date(slot.start_time), "HH:mm")} - ${format(new Date(slot.end_time), "HH:mm")}`,
          amount: b.payment_amount || slot.price_per_session || null,
          cyclusName: slot.cyclus_name || null,
          reminderSentAt: b.reminder_sent_at,
          trainerName: trainerProfileData?.full_name || "Trainer",
        };
      });

      setBookings(mapped);
    } catch (error) {
      logger.error("Error fetching unpaid bookings", error as Error, {
        component: "UnpaidBookingsCard",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleMarkPaid = async (bookingId: string) => {
    setMarkingIds((prev) => new Set(prev).add(bookingId));
    try {
      const { error } = await supabase
        .from("bookings")
        .update({ payment_status: "paid", paid_at: new Date().toISOString() })
        .eq("id", bookingId);

      if (error) throw error;

      setBookings((prev) => prev.filter((b) => b.id !== bookingId));
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(bookingId);
        return next;
      });

      toast({ title: t("unpaidBookings.markPaid") });
    } catch (error) {
      logger.error("Error marking as paid", error as Error, { component: "UnpaidBookingsCard" });
    } finally {
      setMarkingIds((prev) => {
        const next = new Set(prev);
        next.delete(bookingId);
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
        totalAmount: booking.amount || 0,
        unpaidSessions: `<p><strong>${booking.sessionDate}</strong> ${booking.sessionTime}${booking.cyclusName ? ` (${booking.cyclusName})` : ""} — €${(booking.amount || 0).toFixed(2)}</p>`,
      });

      await supabase
        .from("bookings")
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq("id", booking.id);

      setBookings((prev) =>
        prev.map((b) =>
          b.id === booking.id ? { ...b, reminderSentAt: new Date().toISOString() } : b
        )
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
    const selectedBookings = bookings.filter((b) => selected.has(b.id) && b.playerEmail);

    // Group by player email
    const grouped = new Map<string, UnpaidBooking[]>();
    selectedBookings.forEach((b) => {
      const existing = grouped.get(b.playerEmail) || [];
      existing.push(b);
      grouped.set(b.playerEmail, existing);
    });

    const allIds = selectedBookings.map((b) => b.id);
    setSendingIds(new Set(allIds));

    let sentCount = 0;
    for (const [email, playerBookings] of grouped) {
      const totalAmount = playerBookings.reduce((sum, b) => sum + (b.amount || 0), 0);
      const sessionsHtml = playerBookings
        .map(
          (b) =>
            `<p><strong>${b.sessionDate}</strong> ${b.sessionTime}${b.cyclusName ? ` (${b.cyclusName})` : ""} — €${(b.amount || 0).toFixed(2)}</p>`
        )
        .join("");

      try {
        await sendEmail("payment_reminder", email, {
          playerName: playerBookings[0].playerName,
          trainerName: playerBookings[0].trainerName,
          totalAmount,
          unpaidSessions: sessionsHtml,
        });

        const bookingIds = playerBookings.map((b) => b.id);
        await supabase
          .from("bookings")
          .update({ reminder_sent_at: new Date().toISOString() })
          .in("id", bookingIds);

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
    fetchUnpaidBookings();
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
    if (selected.size === bookings.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(bookings.map((b) => b.id)));
    }
  };

  const totalOutstanding = bookings.reduce((sum, b) => sum + (b.amount || 0), 0);

  if (loading) return null;
  if (bookings.length === 0) return null;

  return (
    <Card className="mb-8">
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
            {t("unpaidBookings.totalOutstanding")}: €{totalOutstanding.toFixed(2)}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* Bulk actions */}
        <div className="flex items-center justify-between pb-2 border-b">
          <div className="flex items-center gap-2">
            <Checkbox
              checked={selected.size === bookings.length && bookings.length > 0}
              onCheckedChange={toggleSelectAll}
            />
            <span className="text-sm text-muted-foreground">
              {t("unpaidBookings.selectAll")}
            </span>
          </div>
          {selected.size > 0 && (
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
              {t("unpaidBookings.sendBulkReminder")} ({selected.size})
            </Button>
          )}
        </div>

        {/* Booking rows */}
        {bookings.map((booking) => (
          <div
            key={booking.id}
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
                {booking.cyclusName && (
                  <Badge variant="secondary" className="text-xs">
                    {booking.cyclusName}
                  </Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {booking.sessionDate} · {booking.sessionTime}
                {booking.amount != null && (
                  <span className="ml-2 font-medium text-foreground">
                    €{booking.amount.toFixed(2)}
                  </span>
                )}
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
                onClick={() => handleMarkPaid(booking.id)}
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
      </CardContent>
    </Card>
  );
}
