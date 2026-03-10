import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  format,
  startOfWeek,
  endOfWeek,
  addWeeks,
  subWeeks,
} from "date-fns";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { logger } from '@/lib/logger';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks/useAuth";
import { getUserClubProfiles, getClubTrainerSlots, getClubTrainers } from "@/lib/club";
import { ClubSlotDetailSheet } from "@/components/club/ClubSlotDetailSheet";
import { ClubAddSlotDialog } from "@/components/club/ClubAddSlotDialog";
import { supabase } from "@/lib/supabaseClient";
import { TrainerCalendarGrid } from "@/components/trainer/TrainerCalendarGrid";
import { SlotWithBookings } from "@/components/trainer/CalendarSlotCard";

interface ClubSlot {
  id: string;
  trainer_id: string;
  start_time: string;
  end_time: string;
  is_marked_full: boolean;
  max_participants: number;
  cyclus_name: string | null;
  trainer_name: string;
  trainer_avatar: string | null;
  active_bookings: number;
  pending_bookings: number;
  rating_system?: string | null;
  min_rating?: number | null;
  max_rating?: number | null;
}

interface Trainer {
  id: string;
  name: string;
  avatar: string | null;
  user_id: string;
}

export default function ClubCalendar() {
  const { t } = useTranslation("club");
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  
  const [currentDate, setCurrentDate] = useState(new Date());
  const [slots, setSlots] = useState<ClubSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [clubProfileId, setClubProfileId] = useState<string | null>(null);
  const [clubLocationId, setClubLocationId] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<SlotWithBookings | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  
  // Trainer filter state
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [selectedTrainerId, setSelectedTrainerId] = useState<string>("all");
  
  // Dialog states
  const [addSlotDialogOpen, setAddSlotDialogOpen] = useState(false);
  const [clickedDate, setClickedDate] = useState<Date | undefined>();
  const [clickedTime, setClickedTime] = useState<string | undefined>();

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/app/auth");
    }
  }, [authLoading, user, navigate]);

  useEffect(() => {
    async function loadClub() {
      if (!user) return;
      const clubs = await getUserClubProfiles(user.id);
      if (clubs.length > 0) {
        setClubProfileId(clubs[0].id);
        setClubLocationId(clubs[0].location_id);
        
        // Load trainers
        const clubTrainers = await getClubTrainers(clubs[0].id);
        const trainerList: Trainer[] = [];
        
        for (const t of clubTrainers) {
          const trainer = t.trainer_profiles as any;
          const { data: profile } = await supabase
            .from("profiles")
            .select("full_name, avatar_url")
            .eq("user_id", trainer.user_id)
            .single();
          
          trainerList.push({
            id: trainer.id,
            name: profile?.full_name || "Unknown",
            avatar: profile?.avatar_url || null,
            user_id: trainer.user_id,
          });
        }
        
        setTrainers(trainerList);
      }
    }
    loadClub();
  }, [user]);

  useEffect(() => {
    if (clubProfileId) {
      fetchSlots();
    }
  }, [clubProfileId, currentDate]);

  const fetchSlots = async () => {
    if (!clubProfileId) return;
    
    setLoading(true);
    try {
      const rangeStart = startOfWeek(currentDate, { weekStartsOn: 1 });
      const rangeEnd = endOfWeek(currentDate, { weekStartsOn: 1 });
      
      const slotsData = await getClubTrainerSlots(clubProfileId, rangeStart, rangeEnd);
      setSlots(slotsData as ClubSlot[]);
    } catch (error) {
      logger.error("Error fetching club slots", error instanceof Error ? error : new Error(String(error)), { component: 'ClubCalendar' });
    } finally {
      setLoading(false);
    }
  };

  // Filter slots by selected trainer
  const filteredSlots = useMemo(() => {
    if (selectedTrainerId === "all") return slots;
    return slots.filter(s => s.trainer_id === selectedTrainerId);
  }, [slots, selectedTrainerId]);

  // Map to SlotWithBookings for the shared grid
  const mappedSlots: SlotWithBookings[] = useMemo(() => {
    const now = new Date();
    return filteredSlots.map(slot => ({
      id: slot.id,
      start_time: slot.start_time,
      end_time: slot.end_time,
      max_participants: slot.max_participants || 4,
      price: null,
      active_bookings: slot.active_bookings,
      pending_bookings: slot.pending_bookings,
      is_past: new Date(slot.start_time) < now,
      cyclus_id: null,
      cyclus_name: slot.cyclus_name,
      booked_players: [],
      is_marked_full: slot.is_marked_full,
      location_name: null,
      trainer_id: slot.trainer_id,
      trainer_name: slot.trainer_name,
      trainer_avatar: slot.trainer_avatar,
      rating_system: slot.rating_system || null,
      min_rating: slot.min_rating != null ? Number(slot.min_rating) : null,
      max_rating: slot.max_rating != null ? Number(slot.max_rating) : null,
    }));
  }, [filteredSlots]);

  const navigatePrevious = () => setCurrentDate(subWeeks(currentDate, 1));
  const navigateNext = () => setCurrentDate(addWeeks(currentDate, 1));
  const goToToday = () => setCurrentDate(new Date());

  const getDateRangeLabel = () => {
    const start = startOfWeek(currentDate, { weekStartsOn: 1 });
    const end = endOfWeek(currentDate, { weekStartsOn: 1 });
    return `${format(start, "MMM d")} - ${format(end, "MMM d, yyyy")}`;
  };

  const handleSlotClick = (slot: SlotWithBookings) => {
    setSelectedSlot(slot);
    setSheetOpen(true);
  };

  const handleCellClick = (day: Date, hour: number) => {
    setClickedDate(day);
    setClickedTime(`${String(hour).padStart(2, "0")}:00`);
    setAddSlotDialogOpen(true);
  };

  if (authLoading || (loading && slots.length === 0)) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-8">
          <Skeleton className="h-8 w-48 mb-4" />
          <Skeleton className="h-[500px] w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-8">
        <Card className="overflow-hidden">
          <CardHeader className="pb-2">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              {/* Navigation controls */}
              <div className="flex items-center gap-2">
                <Button variant="outline" size="icon" className="h-8 w-8" onClick={navigatePrevious}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" onClick={goToToday}>
                  {t("calendar.today", "Today")}
                </Button>
                <Button variant="outline" size="icon" className="h-8 w-8" onClick={navigateNext}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <div className="text-sm font-medium ml-4 hidden sm:block">{getDateRangeLabel()}</div>
              </div>
              
              {/* Actions and filters */}
              <div className="flex items-center gap-2 flex-wrap">
                <Select value={selectedTrainerId} onValueChange={setSelectedTrainerId}>
                  <SelectTrigger className="w-[160px] h-8">
                    <SelectValue placeholder={t("calendar.allTrainers", "All Trainers")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("calendar.allTrainers", "All Trainers")}</SelectItem>
                    {trainers.map(trainer => (
                      <SelectItem key={trainer.id} value={trainer.id}>
                        {trainer.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                
                <Button variant="outline" size="sm" onClick={() => { setClickedDate(undefined); setClickedTime(undefined); setAddSlotDialogOpen(true); }}>
                  <Plus className="h-4 w-4 mr-1" />
                  {t("calendar.addSlot", "Add Slot")}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <TrainerCalendarGrid
              slots={mappedSlots}
              currentDate={currentDate}
              view="week"
              showTrainerInfo
              onSlotClick={handleSlotClick}
              onCellClick={handleCellClick}
              onNavigatePrevious={navigatePrevious}
              onNavigateNext={navigateNext}
            />
          </CardContent>
        </Card>
      </div>

      {/* Slot Detail Sheet */}
      <ClubSlotDetailSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        slot={selectedSlot}
      />

      {/* Add Slot Dialog */}
      <ClubAddSlotDialog
        open={addSlotDialogOpen}
        onOpenChange={setAddSlotDialogOpen}
        trainers={trainers.map(t => ({ id: t.id, name: t.name }))}
        defaultTrainerId={selectedTrainerId !== "all" ? selectedTrainerId : undefined}
        defaultDate={clickedDate}
        defaultTime={clickedTime}
        defaultDuration={60}
        clubLocationId={clubLocationId || undefined}
        onSlotsCreated={() => fetchSlots()}
      />

    </div>
  );
}
