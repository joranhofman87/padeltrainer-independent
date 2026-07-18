import { useState, useEffect } from "react";
import { logger } from "@/lib/logger";
import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Users,
  Clock,
  Mail,
  Phone,
  User,
  ExternalLink,
} from "lucide-react";
import { BookingStatusBadge } from "@/components/booking/BookingStatusBadge";
import { PaymentStatusBadge } from "@/components/booking/PaymentStatusBadge";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabaseClient";
import { formatSlotRating as formatSlotRatingDisplay } from "@/components/slots/SlotRatingPicker";
import { useNavigate } from "react-router-dom";
import { useLocalizedPathFn } from "@/hooks/useLocalizedPath";
import { useBookingLoginFlags } from "@/hooks/useBookingLoginFlags";
import { isGuestForBadge } from "@/lib/bookingLoginFlags";
import { SlotWithBookings } from "@/lib/slotTypes";

interface SlotBooking {
  id: string;
  status: string;
  payment_status: string;
  notes: string | null;
  player: {
    id: string;
    full_name: string | null;
    email: string | null;
    phone: string | null;
  } | null;
  guest_player: {
    id: string;
    full_name: string;
    email: string | null;
    phone: string | null;
    skill_rating: number | null;
  } | null;
}

interface ClubSlotDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slot: SlotWithBookings | null;
}

export function ClubSlotDetailSheet({
  open,
  onOpenChange,
  slot,
}: ClubSlotDetailSheetProps) {
  const { t } = useTranslation("club");
  const navigate = useNavigate();
  const localizePath = useLocalizedPathFn();
  const [bookings, setBookings] = useState<SlotBooking[]>([]);
  const [loading, setLoading] = useState(false);
  // Phase 3.5c: badge keys on person-level login (falls back to seat pre-deploy)
  const loginFlags = useBookingLoginFlags(bookings.map((b) => b.id));

  useEffect(() => {
    if (open && slot) {
      fetchBookings();
    } else {
      setBookings([]);
    }
  }, [open, slot]);

  const fetchBookings = async () => {
    if (!slot) return;
    
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("bookings")
        .select(`
          id,
          status,
          payment_status,
          notes,
          player:profiles!bookings_player_id_fkey(
            id:user_id,
            full_name,
            email,
            phone
          ),
          guest_player:guest_players(
            id,
            full_name,
            email,
            phone,
            skill_rating
          )
        `)
        .eq("slot_id", slot.id)
        .in("status", ["confirmed", "pending", "pending_approval"])
        .order("created_at");

      if (error) throw error;
      setBookings((data as SlotBooking[]) || []);
    } catch (error) {
      logger.error("Error fetching bookings", error instanceof Error ? error : new Error(String(error)), { component: 'ClubSlotDetailSheet' });
    } finally {
      setLoading(false);
    }
  };

  const getInitials = (name: string | null) => {
    if (!name) return "?";
    return name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2);
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "confirmed":
        return <BookingStatusBadge status={status} />;
      case "pending":
      case "pending_approval":
        // Deliberate visual delta: the shared badge splits the old single yellow "Pending"
        // chip — pending -> warning "Pending Payment", pending_approval -> info "Awaiting Approval".
        return <BookingStatusBadge status={status} />;
      default:
        // Unreachable given the fetch's status filter; kept so any new status renders
        // nothing here (the shared badge would render the raw status text instead).
        return null;
    }
  };

  const getPaymentBadge = (paymentStatus: string) => {
    switch (paymentStatus) {
      case "paid":
        return <PaymentStatusBadge kind="paid" label={t("calendar.paid", "Paid")} />;
      case "pending":
        return <PaymentStatusBadge kind="pending" label={t("calendar.paymentPending", "Payment Pending")} />;
      case "waived":
        return <PaymentStatusBadge kind="waived" label={t("calendar.waived", "Waived")} />;
      default:
        // The shared badge requires a kind — keep rendering nothing for unknown payment statuses.
        return null;
    }
  };

  if (!slot) return null;

  const maxParticipants = slot.max_participants || 4;
  const startTime = format(new Date(slot.start_time), "HH:mm");
  const endTime = format(new Date(slot.end_time), "HH:mm");
  const slotDate = format(new Date(slot.start_time), "EEEE, MMMM d, yyyy");
  const isPast = new Date(slot.start_time) < new Date();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader className="pb-4 border-b">
          <div className="flex items-center gap-3">
            <Avatar className="h-12 w-12">
              <AvatarImage src={slot.trainer_avatar || undefined} />
              <AvatarFallback>{getInitials(slot.trainer_name ?? null)}</AvatarFallback>
            </Avatar>
            <div>
              <SheetTitle>{slot.cyclus_name || t("calendar.openSlot", "Open Slot")}</SheetTitle>
              <SheetDescription>{slot.trainer_name || ""}</SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="space-y-6 py-6">
          {/* Time Info */}
          <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
            <Clock className="h-5 w-5 text-muted-foreground" />
            <div>
              <div className="font-semibold">{startTime} - {endTime}</div>
              <div className="text-sm text-muted-foreground">{slotDate}</div>
            </div>
            {isPast && (
              <Badge variant="secondary" className="ml-auto">
                {t("calendar.past", "Past")}
              </Badge>
            )}
          </div>

          {/* Status Overview */}
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="gap-1">
              <Users className="h-3 w-3" />
              {slot.active_bookings}/{maxParticipants} {t("calendar.booked", "booked")}
            </Badge>
            {slot.pending_bookings > 0 && (
              <Badge variant="secondary" className="bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30">
                {slot.pending_bookings} {t("calendar.pendingApproval", "pending")}
              </Badge>
            )}
            {!slot.is_public && (
              <Badge variant="secondary" className="bg-purple-100 text-purple-700 dark:bg-purple-900/30">
                {t("calendar.private", "Private")}
              </Badge>
            )}
            {(slot as any).rating_system && (
              <Badge variant="outline" className="gap-1">
                {formatSlotRatingDisplay((slot as any).rating_system, (slot as any).min_rating, (slot as any).max_rating)}
              </Badge>
            )}
          </div>

          {/* Bookings List */}
          <div className="space-y-3">
            <h4 className="font-medium flex items-center gap-2">
              <Users className="h-4 w-4" />
              {t("calendar.players", "Players")}
            </h4>

            {loading ? (
              <div className="space-y-2">
                {[1, 2].map((i) => (
                  <Skeleton key={i} className="h-20 w-full" />
                ))}
              </div>
            ) : bookings.length === 0 ? (
              <EmptyState icon={User} title={t("calendar.noBookings", "No bookings yet")} />
            ) : (
              <div className="space-y-2">
                {bookings.map((booking) => {
                  const playerName = booking.guest_player?.full_name || booking.player?.full_name || "Unknown";
                  const playerEmail = booking.guest_player?.email || booking.player?.email;
                  const playerPhone = booking.guest_player?.phone || booking.player?.phone;
                  const isGuest = !!booking.guest_player;
                  const skillRating = booking.guest_player?.skill_rating;

                  return (
                    <div
                      key={booking.id}
                      className={cn(
                        "p-3 rounded-lg border",
                        booking.status === "confirmed"
                          ? "bg-green-50/50 dark:bg-green-900/10 border-green-200 dark:border-green-800"
                          : "bg-yellow-50/50 dark:bg-yellow-900/10 border-yellow-200 dark:border-yellow-800"
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Avatar className="h-8 w-8">
                            <AvatarFallback className="text-xs">
                              {getInitials(playerName)}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <div className="font-medium text-sm flex items-center gap-2">
                              {playerName}
                              {isGuestForBadge(loginFlags, booking.id, isGuest) && (
                                <Badge variant="outline" className="text-xs">
                                  {t("calendar.guest", "Guest")}
                                </Badge>
                              )}
                              {skillRating && (
                                <Badge variant="secondary" className="text-xs">
                                  {skillRating}
                                </Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-3 mt-1">
                              {getStatusBadge(booking.status)}
                              {getPaymentBadge(booking.payment_status)}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Contact Info */}
                      <div className="mt-3 pt-2 border-t border-dashed space-y-1">
                        {playerEmail && (
                          <a
                            href={`mailto:${playerEmail}`}
                            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
                          >
                            <Mail className="h-3 w-3" />
                            {playerEmail}
                          </a>
                        )}
                        {playerPhone && (
                          <a
                            href={`tel:${playerPhone}`}
                            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
                          >
                            <Phone className="h-3 w-3" />
                            {playerPhone}
                          </a>
                        )}
                      </div>

                      {/* Notes */}
                      {booking.notes && (
                        <div className="mt-2 pt-2 border-t border-dashed">
                          <p className="text-sm text-muted-foreground italic">
                            "{booking.notes}"
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Empty Slots */}
            {!loading && bookings.length < maxParticipants && (
              <div className="space-y-1">
                {Array.from({ length: maxParticipants - bookings.length }).map((_, i) => (
                  <div
                    key={`empty-${i}`}
                    className="flex items-center gap-2 p-2 rounded-lg border border-dashed text-muted-foreground"
                  >
                    <User className="h-4 w-4" />
                    <span className="text-sm">{t("calendar.emptySlot", "Empty slot")}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* View Trainer Profile Button */}
          {slot.trainer_id && (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => navigate(localizePath(`/trainer/${slot.trainer_id}`))}
            >
              <ExternalLink className="h-4 w-4 mr-2" />
              {t("calendar.viewTrainerProfile", "View Trainer Profile")}
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
