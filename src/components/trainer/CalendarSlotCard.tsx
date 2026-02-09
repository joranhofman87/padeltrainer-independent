import { useState } from "react";
import { format } from "date-fns";
import { Users, UserPlus, Repeat, Copy, Pencil, Trash2, User, Clock, Check, Lock, LockOpen, MapPin, Euro } from "lucide-react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

export interface BookedPlayer {
  id: string;
  bookingId: string;
  name: string;
  status: "confirmed" | "pending";
  isGuest: boolean;
  skillRating?: number | null;
  ratingSystem?: string;
  paymentStatus?: string;
}

export interface SlotWithBookings {
  id: string;
  start_time: string;
  end_time: string;
  max_participants: number;
  price: number | null;
  active_bookings: number;
  pending_bookings: number;
  is_past: boolean;
  cyclus_id: string | null;
  cyclus_name: string | null;
  booked_players: BookedPlayer[];
  is_marked_full: boolean;
  location_name: string | null;
  trainer_id?: string;
  trainer_name?: string;
  trainer_avatar?: string;
}

type SlotStatus = "free" | "partial" | "full" | "past" | "private";

function getSlotStatus(slot: SlotWithBookings): SlotStatus {
  if (slot.is_past) return "past";
  if (slot.is_marked_full) return "private";
  if (slot.active_bookings >= 4) return "full";
  if (slot.active_bookings > 0) return "partial";
  return "free";
}

const statusColors: Record<SlotStatus, string> = {
  free: "bg-green-100 dark:bg-green-900/30 border-green-300 dark:border-green-700 hover:bg-green-200 dark:hover:bg-green-900/50",
  partial: "bg-orange-100 dark:bg-orange-900/30 border-orange-300 dark:border-orange-700 hover:bg-orange-200 dark:hover:bg-orange-900/50",
  full: "bg-blue-100 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700 hover:bg-blue-200 dark:hover:bg-blue-900/50",
  past: "bg-muted/30 border-muted opacity-50",
  private: "bg-purple-100 dark:bg-purple-900/30 border-purple-300 dark:border-purple-700 hover:bg-purple-200 dark:hover:bg-purple-900/50",
};

const statusTextColors: Record<SlotStatus, string> = {
  free: "text-green-700 dark:text-green-300",
  partial: "text-orange-700 dark:text-orange-300",
  full: "text-blue-700 dark:text-blue-300",
  past: "text-muted-foreground",
  private: "text-purple-700 dark:text-purple-300",
};

interface CalendarSlotCardProps {
  slot: SlotWithBookings;
  compact?: boolean;
  cyclusSessions?: number;
  durationHours?: number;
  startOffset?: number;
  showTrainerInfo?: boolean;
  onSlotClick?: (slot: SlotWithBookings) => void;
  onBookForPlayer?: (slot: SlotWithBookings) => void;
  onDuplicateCyclus?: (cyclusId: string) => void;
  onEditSlot?: (slot: SlotWithBookings) => void;
  onDeleteSlot?: (slot: SlotWithBookings) => void;
  onEditBooking?: (bookingId: string) => void;
  onToggleMarkedFull?: (slotId: string, value: boolean, applyToCyclus?: boolean) => void;
}

// Calculate average rating of booked players
function calculateAverageRating(players: BookedPlayer[]): { average: number | null; system: string | null; count: number } {
  const playersWithRatings = players.filter(p => p.skillRating != null);
  if (playersWithRatings.length === 0) return { average: null, system: null, count: 0 };
  
  // Check if all players use the same system (prioritize showing that)
  const systems = playersWithRatings.map(p => p.ratingSystem).filter(Boolean);
  const dominantSystem = systems.length > 0 ? systems[0] : 'knltb';
  
  const sum = playersWithRatings.reduce((acc, p) => acc + (p.skillRating || 0), 0);
  return { 
    average: sum / playersWithRatings.length, 
    system: dominantSystem || null,
    count: playersWithRatings.length 
  };
}

export function CalendarSlotCard({ slot, compact = false, cyclusSessions, durationHours = 1, startOffset = 0, showTrainerInfo, onSlotClick, onBookForPlayer, onDuplicateCyclus, onEditSlot, onDeleteSlot, onEditBooking, onToggleMarkedFull }: CalendarSlotCardProps) {
  const { t } = useTranslation("trainer");
  const navigate = useNavigate();
  const status = getSlotStatus(slot);
  const startTime = format(new Date(slot.start_time), "HH:mm");
  const endTime = format(new Date(slot.end_time), "HH:mm");
  const spotsLeft = 4 - slot.active_bookings;
  const hasSpots = spotsLeft > 0;

  // State for apply to cyclus checkbox
  const [applyToCyclus, setApplyToCyclus] = useState(false);

  // Calculate average rating for display
  const ratingInfo = calculateAverageRating(slot.booked_players || []);

  const statusLabel = {
    free: t("calendar.fullyOpen"),
    partial: t("calendar.spotsLeft", { count: spotsLeft }),
    full: t("calendar.fullyBooked"),
    past: t("calendar.past"),
    private: t("calendar.markedFull"),
  }[status];

  // Calculate height for multi-hour slots (80px per hour minus some padding)
  // And top offset for :30 start times
  const cellHeight = 80;
  const needsPositioning = durationHours !== 1 || startOffset > 0;
  const spanHeight = needsPositioning ? `${durationHours * cellHeight - 8}px` : undefined;
  const topOffset = startOffset > 0 ? `${startOffset * cellHeight}px` : undefined;

  const cardContent = (
    <div
      className={cn(
        "rounded-md border p-2 cursor-pointer transition-colors text-xs",
        statusColors[status],
        compact && "p-1",
        needsPositioning && "absolute left-1 right-1 z-10"
      )}
      style={{ 
        height: spanHeight,
        top: topOffset 
      }}
    >
      <div className={cn("font-medium flex items-center gap-1", statusTextColors[status])}>
        {startTime} - {endTime}
        {!compact && slot.cyclus_id && (
          <Repeat className="h-3 w-3 opacity-60" />
        )}
        {!compact && slot.is_marked_full && (
          <Lock className="h-3 w-3 opacity-60" />
        )}
      </div>
      {!compact && slot.cyclus_name && (
        <div className="text-foreground/80 truncate mt-0.5">
          {slot.cyclus_name}
        </div>
      )}
      {!compact && showTrainerInfo && slot.trainer_name && (
        <div className="flex items-center gap-1 mt-0.5">
          <Avatar className="h-3.5 w-3.5">
            <AvatarImage src={slot.trainer_avatar || undefined} />
            <AvatarFallback className="text-[7px]">
              {slot.trainer_name.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2)}
            </AvatarFallback>
          </Avatar>
          <span className="text-foreground/70 truncate text-[10px]">{slot.trainer_name}</span>
        </div>
      )}
      {!compact && (
        <div className={cn("flex items-center gap-1 mt-1", statusTextColors[status])}>
          <Users className="h-3 w-3" />
          <span>
            {slot.active_bookings}/4
          </span>
        </div>
      )}
    </div>
  );

  if (onSlotClick) {
    return <div onClick={(e) => { e.stopPropagation(); onSlotClick(slot); }}>{cardContent}</div>;
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

          {slot.cyclus_name && (
            <div>
              <div className="text-sm font-medium">{slot.cyclus_name}</div>
              {slot.price && (
                <div className="text-sm text-muted-foreground">
                  €{slot.price}
                </div>
              )}
            </div>
          )}

          {slot.location_name && (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <MapPin className="h-3.5 w-3.5" />
              <span>{slot.location_name}</span>
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap">
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
              {slot.active_bookings}/4 {t("calendar.booked").toLowerCase()}
            </div>
          </div>

          {/* Average Level Badge */}
          {ratingInfo.average !== null && (
            <div className="flex items-center gap-2 p-2 bg-primary/5 rounded-md border border-primary/10">
              <div className="text-xs text-muted-foreground">{t("calendar.averageLevel", "Avg. Level")}:</div>
              <Badge variant="secondary" className="font-semibold">
                {ratingInfo.average.toFixed(1)}
              </Badge>
              <span className="text-xs text-muted-foreground uppercase">
                {ratingInfo.system || 'knltb'}
              </span>
            </div>
          )}

          {/* Player Slots Section - Always show max_participants boxes */}
          <div className="space-y-2">
            <div className="text-sm font-medium">{t("calendar.players")}</div>
            <div className="space-y-1">
              {Array.from({ length: 4 }).map((_, index) => {
                const player = slot.booked_players?.[index];
                
                if (player) {
                  // Filled slot
                  return (
                    <div
                      key={player.id}
                      className={cn(
                        "flex items-center justify-between text-sm px-2 py-1.5 rounded-md",
                        player.status === "confirmed"
                          ? "bg-green-50 dark:bg-green-900/20"
                          : "bg-yellow-50 dark:bg-yellow-900/20"
                      )}
                    >
                      <div className="flex items-center gap-2">
                        {player.status === "confirmed" ? (
                          <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
                        ) : (
                          <Clock className="h-3 w-3 text-yellow-600 dark:text-yellow-400" />
                        )}
                        <span className={cn(
                          player.status === "confirmed"
                            ? "text-green-700 dark:text-green-300"
                            : "text-yellow-700 dark:text-yellow-300"
                        )}>
                          {player.name}
                        </span>
                        {player.paymentStatus === "paid" ? (
                          <Euro className="h-3 w-3 text-green-600 dark:text-green-400" />
                        ) : (
                          <Euro className="h-3 w-3 text-orange-500 dark:text-orange-400" />
                        )}
                        {player.isGuest && (
                          <span className="text-xs text-muted-foreground">
                            ({t("calendar.guest")})
                          </span>
                        )}
                      </div>
                      {onEditBooking && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={(e) => {
                            e.stopPropagation();
                            onEditBooking(player.bookingId);
                          }}
                          title={t("bookings.editBooking", "Edit Booking")}
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  );
                } else {
                  // Empty slot - clickable to add player
                  const canBook = hasSpots && onBookForPlayer && !slot.is_past;
                  return (
                    <div
                      key={`empty-${index}`}
                      className={cn(
                        "flex items-center justify-between text-sm px-2 py-1.5 rounded-md bg-muted/50 border border-dashed border-muted-foreground/30",
                        canBook && "cursor-pointer hover:bg-muted hover:border-primary/50 transition-colors"
                      )}
                      onClick={(e) => {
                        if (canBook) {
                          e.stopPropagation();
                          onBookForPlayer(slot);
                        }
                      }}
                    >
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <User className="h-3 w-3" />
                        <span className="italic">{t("calendar.emptySlot", "Empty slot")}</span>
                      </div>
                      {canBook && (
                        <UserPlus className="h-3 w-3 text-primary opacity-60" />
                      )}
                    </div>
                  );
                }
              })}
            </div>
          </div>

          {/* Mark as Full Toggle */}
          {onToggleMarkedFull && !slot.is_past && (
            <div className="space-y-2 pt-2 border-t">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-2 cursor-pointer text-sm">
                  {slot.is_marked_full ? <Lock className="h-4 w-4" /> : <LockOpen className="h-4 w-4" />}
                  {t("calendar.markAsFull")}
                </Label>
                <Switch
                  checked={slot.is_marked_full}
                  onCheckedChange={(checked) => {
                    onToggleMarkedFull(slot.id, checked, slot.cyclus_id && applyToCyclus ? true : false);
                  }}
                />
              </div>
              {slot.cyclus_id && (
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`apply-cyclus-toggle-${slot.id}`}
                    checked={applyToCyclus}
                    onCheckedChange={(c) => setApplyToCyclus(!!c)}
                  />
                  <Label htmlFor={`apply-cyclus-toggle-${slot.id}`} className="text-xs cursor-pointer">
                    {t("calendar.applyToEntireCyclus")}
                  </Label>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {slot.is_marked_full ? t("calendar.markedFull") : t("calendar.openToPlayers")}
              </p>
            </div>
          )}

          {/* Action icons row */}
          <div className="flex items-center justify-between pt-1 border-t">
            <div className="flex gap-1">
              {onEditSlot && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => onEditSlot(slot)}
                  title={t("common:edit", "Edit")}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
              )}
              {slot.cyclus_id && onDuplicateCyclus && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => onDuplicateCyclus(slot.cyclus_id!)}
                  title={t("calendar.duplicateCyclus")}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              )}
              {onDeleteSlot && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => onDeleteSlot(slot)}
                  title={t("common:delete", "Delete")}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
            
            {hasSpots && onBookForPlayer && !slot.is_past && (
              <Button
                variant="default"
                size="sm"
                onClick={() => onBookForPlayer(slot)}
              >
                <UserPlus className="mr-2 h-4 w-4" />
                {t("bookings.bookForPlayer")}
              </Button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
