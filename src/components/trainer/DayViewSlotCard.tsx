import { useState } from "react";
import { format } from "date-fns";
import { 
  Users, 
  UserPlus, 
  Repeat, 
  Copy, 
  Pencil, 
  Trash2, 
  User, 
  Clock, 
  Check, 
  Lock, 
  LockOpen,
  MoreHorizontal,
  ChevronDown,
  ChevronUp
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useTranslation } from "react-i18next";
import { SlotWithBookings, BookedPlayer } from "./CalendarSlotCard";

type SlotStatus = "free" | "partial" | "full" | "past" | "private";

function getSlotStatus(slot: SlotWithBookings): SlotStatus {
  if (slot.is_past) return "past";
  if (slot.is_marked_full) return "private";
  if (slot.active_bookings >= 4) return "full";
  if (slot.active_bookings > 0) return "partial";
  return "free";
}

const statusColors: Record<SlotStatus, string> = {
  free: "bg-green-100 dark:bg-green-900/30 border-green-300 dark:border-green-700",
  partial: "bg-orange-100 dark:bg-orange-900/30 border-orange-300 dark:border-orange-700",
  full: "bg-blue-100 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700",
  past: "bg-muted/30 border-muted opacity-60",
  private: "bg-purple-100 dark:bg-purple-900/30 border-purple-300 dark:border-purple-700",
};

const statusTextColors: Record<SlotStatus, string> = {
  free: "text-green-700 dark:text-green-300",
  partial: "text-orange-700 dark:text-orange-300",
  full: "text-blue-700 dark:text-blue-300",
  past: "text-muted-foreground",
  private: "text-purple-700 dark:text-purple-300",
};

interface DayViewSlotCardProps {
  slot: SlotWithBookings;
  onBookForPlayer?: (slot: SlotWithBookings) => void;
  onDuplicateCyclus?: (cyclusId: string) => void;
  onDeleteSlot?: (slot: SlotWithBookings) => void;
  onEditBooking?: (bookingId: string) => void;
  onToggleMarkedFull?: (slotId: string, value: boolean, applyToCyclus?: boolean) => void;
}

function calculateAverageRating(players: BookedPlayer[]): { average: number | null; system: string | null; count: number } {
  const playersWithRatings = players.filter(p => p.skillRating != null);
  if (playersWithRatings.length === 0) return { average: null, system: null, count: 0 };
  
  const systems = playersWithRatings.map(p => p.ratingSystem).filter(Boolean);
  const dominantSystem = systems.length > 0 ? systems[0] : 'knltb';
  
  const sum = playersWithRatings.reduce((acc, p) => acc + (p.skillRating || 0), 0);
  return { 
    average: sum / playersWithRatings.length, 
    system: dominantSystem || null,
    count: playersWithRatings.length 
  };
}

export function DayViewSlotCard({ 
  slot, 
  onBookForPlayer, 
  onDuplicateCyclus, 
  onDeleteSlot, 
  onEditBooking, 
  onToggleMarkedFull 
}: DayViewSlotCardProps) {
  const { t } = useTranslation("trainer");
  const status = getSlotStatus(slot);
  const startTime = format(new Date(slot.start_time), "HH:mm");
  const endTime = format(new Date(slot.end_time), "HH:mm");
  const spotsLeft = 4 - slot.active_bookings;
  const hasSpots = spotsLeft > 0;
  const ratingInfo = calculateAverageRating(slot.booked_players || []);

  const [applyToCyclus, setApplyToCyclus] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);

  const statusLabel = {
    free: t("calendar.fullyOpen"),
    partial: t("calendar.spotsLeft", { count: spotsLeft }),
    full: t("calendar.fullyBooked"),
    past: t("calendar.past"),
    private: t("calendar.markedFull"),
  }[status];

  return (
    <div className={cn(
      "rounded-lg border-2 overflow-hidden transition-all",
      statusColors[status]
    )}>
      {/* Header Section */}
      <div className="p-4 bg-background/50">
        <div className="flex items-start justify-between gap-4">
          {/* Time and Lesson Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-2">
              <div className={cn("text-2xl font-bold", statusTextColors[status])}>
                {startTime}
              </div>
              <span className="text-muted-foreground">-</span>
              <div className={cn("text-2xl font-bold", statusTextColors[status])}>
                {endTime}
              </div>
              {slot.cyclus_id && (
                <Badge variant="secondary" className="gap-1">
                  <Repeat className="h-3 w-3" />
                  {slot.cyclus_name || t("calendar.cyclus")}
                </Badge>
              )}
              {slot.is_marked_full && (
                <Badge variant="outline" className="gap-1 border-purple-300 text-purple-700 dark:text-purple-300">
                  <Lock className="h-3 w-3" />
                  {t("calendar.markedFull")}
                </Badge>
              )}
            </div>
            
            <div className="flex items-center gap-4 flex-wrap">
              {slot.lesson_title && (
                <div className="font-medium text-lg">{slot.lesson_title}</div>
              )}
              {slot.price && (
                <Badge variant="outline" className="font-semibold">
                  €{slot.price}
                </Badge>
              )}
              <div className={cn(
                "px-3 py-1 rounded-full text-sm font-medium",
                statusColors[status],
                statusTextColors[status]
              )}>
                {statusLabel}
              </div>
            </div>
          </div>

          {/* Actions Menu */}
          <div className="flex items-center gap-2">
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {slot.cyclus_id && onDuplicateCyclus && (
                  <DropdownMenuItem onClick={() => onDuplicateCyclus(slot.cyclus_id!)}>
                    <Copy className="mr-2 h-4 w-4" />
                    {t("calendar.duplicateCyclus")}
                  </DropdownMenuItem>
                )}
                {onDeleteSlot && (
                  <DropdownMenuItem 
                    onClick={() => onDeleteSlot(slot)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    {t("calendar.deleteSlot", "Delete Slot")}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Collapsible Players Section */}
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <CollapsibleTrigger asChild>
          <button className="w-full px-4 py-2 flex items-center justify-between bg-muted/30 hover:bg-muted/50 transition-colors border-t">
            <div className="flex items-center gap-3">
              <Users className="h-4 w-4" />
              <span className="font-medium">
                {t("calendar.players")} ({slot.active_bookings}/4)
              </span>
              {ratingInfo.average !== null && (
                <Badge variant="secondary" className="text-xs">
                  {t("calendar.averageLevel")}: {ratingInfo.average.toFixed(1)} {ratingInfo.system?.toUpperCase()}
                </Badge>
              )}
            </div>
            {isExpanded ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="p-4 space-y-2 bg-background/30">
            {/* Player Slots Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {Array.from({ length: 4 }).map((_, index) => {
                const player = slot.booked_players?.[index];
                
                if (player) {
                  return (
                    <div
                      key={player.id}
                      className={cn(
                        "flex items-center justify-between p-3 rounded-lg border",
                        player.status === "confirmed"
                          ? "bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800"
                          : "bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800"
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <div className={cn(
                          "w-8 h-8 rounded-full flex items-center justify-center",
                          player.status === "confirmed"
                            ? "bg-green-100 dark:bg-green-900/50"
                            : "bg-yellow-100 dark:bg-yellow-900/50"
                        )}>
                          {player.status === "confirmed" ? (
                            <Check className="h-4 w-4 text-green-600 dark:text-green-400" />
                          ) : (
                            <Clock className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
                          )}
                        </div>
                        <div>
                          <div className="font-medium flex items-center gap-2">
                            {player.name}
                            {player.isGuest && (
                              <Badge variant="outline" className="text-xs px-1.5 py-0">
                                {t("calendar.guest")}
                              </Badge>
                            )}
                          </div>
                          <div className="text-sm text-muted-foreground flex items-center gap-2">
                            {player.skillRating != null ? (
                              <>
                                <span>{t("calendar.playerRating", "Rating")}:</span>
                                <span className="font-medium">{player.skillRating}</span>
                                <span className="uppercase text-xs">{player.ratingSystem || 'knltb'}</span>
                              </>
                            ) : (
                              <span className="italic">{t("calendar.noRating", "No rating")}</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        {onEditBooking && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => onEditBooking(player.bookingId)}
                            title={t("bookings.editBooking")}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                } else {
                  const canBook = hasSpots && onBookForPlayer && !slot.is_past;
                  return (
                    <div
                      key={`empty-${index}`}
                      className={cn(
                        "flex items-center justify-between p-3 rounded-lg border-2 border-dashed",
                        canBook 
                          ? "border-muted-foreground/30 hover:border-primary/50 hover:bg-muted/50 cursor-pointer transition-colors" 
                          : "border-muted-foreground/20 bg-muted/20"
                      )}
                      onClick={() => canBook && onBookForPlayer(slot)}
                    >
                      <div className="flex items-center gap-3 text-muted-foreground">
                        <div className="w-8 h-8 rounded-full flex items-center justify-center bg-muted/50">
                          <User className="h-4 w-4" />
                        </div>
                        <span className="italic">{t("calendar.emptySlot", "Empty slot")}</span>
                      </div>
                      {canBook && (
                        <UserPlus className="h-4 w-4 text-primary opacity-60" />
                      )}
                    </div>
                  );
                }
              })}
            </div>

            {/* Mark as Full Toggle */}
            {onToggleMarkedFull && !slot.is_past && (
              <div className="mt-4 pt-4 border-t space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="flex items-center gap-2 cursor-pointer">
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
                      id={`apply-cyclus-day-${slot.id}`}
                      checked={applyToCyclus}
                      onCheckedChange={(c) => setApplyToCyclus(!!c)}
                    />
                    <Label htmlFor={`apply-cyclus-day-${slot.id}`} className="text-sm cursor-pointer">
                      {t("calendar.applyToEntireCyclus")}
                    </Label>
                  </div>
                )}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
