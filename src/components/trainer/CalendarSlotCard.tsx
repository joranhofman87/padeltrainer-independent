import { format } from "date-fns";
import { Users, UserPlus, Repeat, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

export interface SlotWithBookings {
  id: string;
  start_time: string;
  end_time: string;
  lesson_id: string | null;
  lesson_title: string | null;
  max_participants: number;
  price: number | null;
  active_bookings: number;
  pending_bookings: number;
  is_past: boolean;
  cyclus_id: string | null;
  cyclus_name: string | null;
}

type SlotStatus = "free" | "pending" | "partial" | "full" | "past";

function getSlotStatus(slot: SlotWithBookings): SlotStatus {
  if (slot.is_past) return "past";
  if (slot.active_bookings >= slot.max_participants) return "full";
  if (slot.active_bookings > 0) return "partial";
  if (slot.pending_bookings > 0) return "pending";
  return "free";
}

const statusColors: Record<SlotStatus, string> = {
  free: "bg-muted/50 border-border hover:bg-muted",
  pending: "bg-yellow-100 dark:bg-yellow-900/30 border-yellow-300 dark:border-yellow-700 hover:bg-yellow-200 dark:hover:bg-yellow-900/50",
  partial: "bg-orange-100 dark:bg-orange-900/30 border-orange-300 dark:border-orange-700 hover:bg-orange-200 dark:hover:bg-orange-900/50",
  full: "bg-green-100 dark:bg-green-900/30 border-green-300 dark:border-green-700 hover:bg-green-200 dark:hover:bg-green-900/50",
  past: "bg-muted/30 border-muted opacity-50",
};

const statusTextColors: Record<SlotStatus, string> = {
  free: "text-muted-foreground",
  pending: "text-yellow-700 dark:text-yellow-300",
  partial: "text-orange-700 dark:text-orange-300",
  full: "text-green-700 dark:text-green-300",
  past: "text-muted-foreground",
};

interface CalendarSlotCardProps {
  slot: SlotWithBookings;
  compact?: boolean;
  cyclusSessions?: number;
  onBookForPlayer?: (slot: SlotWithBookings) => void;
  onDuplicateCyclus?: (cyclusId: string) => void;
}

export function CalendarSlotCard({ slot, compact = false, cyclusSessions, onBookForPlayer, onDuplicateCyclus }: CalendarSlotCardProps) {
  const { t } = useTranslation("trainer");
  const navigate = useNavigate();
  const status = getSlotStatus(slot);
  const startTime = format(new Date(slot.start_time), "HH:mm");
  const endTime = format(new Date(slot.end_time), "HH:mm");
  const spotsLeft = slot.max_participants - slot.active_bookings;
  const hasSpots = spotsLeft > 0;

  const statusLabel = {
    free: t("calendar.available"),
    pending: t("calendar.pending"),
    partial: t("calendar.spotsLeft", { count: spotsLeft }),
    full: t("calendar.fullyBooked"),
    past: t("calendar.past"),
  }[status];

  const cardContent = (
    <div
      className={cn(
        "rounded-md border p-2 cursor-pointer transition-colors text-xs",
        statusColors[status],
        compact && "p-1"
      )}
    >
      <div className={cn("font-medium flex items-center gap-1", statusTextColors[status])}>
        {startTime} - {endTime}
        {!compact && slot.cyclus_id && (
          <Repeat className="h-3 w-3 opacity-60" />
        )}
      </div>
      {!compact && slot.lesson_title && (
        <div className="text-foreground/80 truncate mt-0.5">
          {slot.lesson_title}
        </div>
      )}
      {!compact && (
        <div className={cn("flex items-center gap-1 mt-1", statusTextColors[status])}>
          <Users className="h-3 w-3" />
          <span>
            {slot.active_bookings}/{slot.max_participants}
          </span>
        </div>
      )}
    </div>
  );

  if (slot.is_past) {
    return cardContent;
  }

  return (
    <Popover>
      <PopoverTrigger asChild>{cardContent}</PopoverTrigger>
      <PopoverContent className="w-64" align="start">
        <div className="space-y-3">
          <div>
            <div className="font-semibold">
              {startTime} - {endTime}
            </div>
            <div className="text-sm text-muted-foreground">
              {format(new Date(slot.start_time), "EEEE, MMMM d")}
            </div>
          </div>

          {slot.cyclus_id && slot.cyclus_name && (
            <Badge variant="secondary" className="gap-1 text-xs">
              <Repeat className="h-3 w-3" />
              {slot.cyclus_name}
              {cyclusSessions && cyclusSessions > 1 && (
                <span className="text-muted-foreground ml-1">
                  ({cyclusSessions} {t("calendar.sessions")})
                </span>
              )}
            </Badge>
          )}

          {slot.lesson_title && (
            <div>
              <div className="text-sm font-medium">{slot.lesson_title}</div>
              {slot.price && (
                <div className="text-sm text-muted-foreground">
                  €{slot.price}
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <div
              className={cn(
                "px-2 py-1 rounded text-xs font-medium",
                statusColors[status],
                statusTextColors[status]
              )}
            >
              {statusLabel}
            </div>
            <div className="text-sm text-muted-foreground">
              <Users className="h-3 w-3 inline mr-1" />
              {slot.active_bookings}/{slot.max_participants} {t("calendar.booked").toLowerCase()}
            </div>
          </div>

          {slot.active_bookings > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => navigate("/trainer-bookings")}
            >
              {t("bookings.title")}
            </Button>
          )}

          {hasSpots && onBookForPlayer && (
            <Button
              variant="default"
              size="sm"
              className="w-full"
              onClick={() => onBookForPlayer(slot)}
            >
              <UserPlus className="mr-2 h-4 w-4" />
              {t("bookings.bookForPlayer")}
            </Button>
          )}

          {slot.cyclus_id && onDuplicateCyclus && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => onDuplicateCyclus(slot.cyclus_id!)}
            >
              <Copy className="mr-2 h-4 w-4" />
              {t("calendar.duplicateCyclus")}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
