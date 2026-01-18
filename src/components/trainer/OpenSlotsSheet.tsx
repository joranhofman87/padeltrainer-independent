import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { Calendar, RotateCcw, UserPlus, ArrowRight } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { BookForPlayerDialog } from './BookForPlayerDialog';

interface CyclusGroup {
  cyclus_id: string;
  cyclus_name: string;
  lesson_title: string | null;
  open_slots: number;
  total_slots: number;
  next_slot: {
    id: string;
    start_time: string;
    lesson_id: string | null;
    max_participants: number;
    available_spots: number;
  } | null;
  slots: SlotData[];
}

interface SlotData {
  id: string;
  start_time: string;
  end_time: string;
  lesson_id: string | null;
  lesson_title: string | null;
  max_participants: number;
  booked_count: number;
  available_spots: number;
  cyclus_id: string | null;
}

interface OpenSlotsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trainerId: string;
}

export function OpenSlotsSheet({ open, onOpenChange, trainerId }: OpenSlotsSheetProps) {
  const { t, i18n } = useTranslation('trainer');
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [cyclusGroups, setCyclusGroups] = useState<CyclusGroup[]>([]);
  const [individualSlots, setIndividualSlots] = useState<SlotData[]>([]);
  const [bookDialogOpen, setBookDialogOpen] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<SlotData | null>(null);

  const dateLocale = i18n.language === 'nl' ? nl : enUS;

  useEffect(() => {
    if (open && trainerId) {
      fetchOpenSlots();
    }
  }, [open, trainerId]);

  const fetchOpenSlots = async () => {
    setLoading(true);
    try {
      // Fetch all future slots with their bookings and lessons
      const { data: slots, error } = await supabase
        .from('availability_slots')
        .select(`
          id,
          start_time,
          end_time,
          lesson_id,
          cyclus_id,
          cyclus_name,
          is_marked_full,
          lessons(id, title, max_participants)
        `)
        .eq('trainer_id', trainerId)
        .eq('is_marked_full', false)
        .gte('start_time', new Date().toISOString())
        .order('start_time', { ascending: true });

      if (error) throw error;

      // Fetch bookings for these slots
      const slotIds = slots?.map(s => s.id) || [];
      const { data: bookings } = await supabase
        .from('bookings')
        .select('slot_id, status')
        .in('slot_id', slotIds)
        .in('status', ['confirmed', 'pending']);

      // Count bookings per slot
      const bookingCounts: Record<string, number> = {};
      bookings?.forEach(b => {
        bookingCounts[b.slot_id] = (bookingCounts[b.slot_id] || 0) + 1;
      });

      // Process slots
      const processedSlots: SlotData[] = (slots || []).map(slot => {
        const maxParticipants = slot.lessons?.max_participants || 4;
        const bookedCount = bookingCounts[slot.id] || 0;
        const availableSpots = maxParticipants - bookedCount;

        return {
          id: slot.id,
          start_time: slot.start_time,
          end_time: slot.end_time,
          lesson_id: slot.lesson_id,
          lesson_title: slot.lessons?.title || null,
          max_participants: maxParticipants,
          booked_count: bookedCount,
          available_spots: availableSpots,
          cyclus_id: slot.cyclus_id,
        };
      }).filter(slot => slot.available_spots > 0);

      // Group by cyclus
      const cyclusMap = new Map<string, CyclusGroup>();
      const individual: SlotData[] = [];

      processedSlots.forEach(slot => {
        if (slot.cyclus_id) {
          const existing = cyclusMap.get(slot.cyclus_id);
          const slotInfo = slots?.find(s => s.id === slot.id);
          
          if (existing) {
            existing.slots.push(slot);
            existing.open_slots++;
            existing.total_slots++;
            if (!existing.next_slot || new Date(slot.start_time) < new Date(existing.next_slot.start_time)) {
              existing.next_slot = {
                id: slot.id,
                start_time: slot.start_time,
                lesson_id: slot.lesson_id,
                max_participants: slot.max_participants,
                available_spots: slot.available_spots,
              };
            }
          } else {
            cyclusMap.set(slot.cyclus_id, {
              cyclus_id: slot.cyclus_id,
              cyclus_name: slotInfo?.cyclus_name || `Cyclus ${slot.cyclus_id.slice(0, 8)}`,
              lesson_title: slot.lesson_title,
              open_slots: 1,
              total_slots: 1,
              next_slot: {
                id: slot.id,
                start_time: slot.start_time,
                lesson_id: slot.lesson_id,
                max_participants: slot.max_participants,
                available_spots: slot.available_spots,
              },
              slots: [slot],
            });
          }
        } else {
          individual.push(slot);
        }
      });

      setCyclusGroups(Array.from(cyclusMap.values()));
      setIndividualSlots(individual);
    } catch (error) {
      console.error('Error fetching open slots:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleBookPlayer = (slot: SlotData) => {
    setSelectedSlot(slot);
    setBookDialogOpen(true);
  };

  const handleBookingCreated = () => {
    fetchOpenSlots();
    setBookDialogOpen(false);
    setSelectedSlot(null);
  };

  const handleViewCalendar = () => {
    onOpenChange(false);
    navigate('/trainer/calendar');
  };

  const formatSlotTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return format(date, 'EEE d MMM', { locale: dateLocale }) + ' ' + t('calendar.at') + ' ' + format(date, 'HH:mm');
  };

  const hasOpenSlots = cyclusGroups.length > 0 || individualSlots.length > 0;

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{t('openSlots.title', 'Open Training Slots')}</SheetTitle>
            <SheetDescription>
              {t('openSlots.description', 'Overview of all slots with available spots')}
            </SheetDescription>
          </SheetHeader>

          <ScrollArea className="h-[calc(100vh-12rem)] mt-4 pr-4">
            {loading ? (
              <div className="space-y-4">
                {[1, 2, 3].map(i => (
                  <Skeleton key={i} className="h-24 w-full" />
                ))}
              </div>
            ) : !hasOpenSlots ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Calendar className="h-12 w-12 text-muted-foreground mb-4" />
                <p className="text-muted-foreground">
                  {t('openSlots.noOpenSlots', 'No open slots available')}
                </p>
                <Button variant="outline" className="mt-4" onClick={handleViewCalendar}>
                  {t('openSlots.createSlots', 'Create new slots')}
                </Button>
              </div>
            ) : (
              <div className="space-y-6">
                {/* Training Cycles */}
                {cyclusGroups.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
                      <RotateCcw className="h-4 w-4" />
                      {t('openSlots.trainingCycles', 'Training Cycles')}
                    </h3>
                    <div className="space-y-3">
                      {cyclusGroups.map(cyclus => (
                        <div
                          key={cyclus.cyclus_id}
                          className="border rounded-lg p-4 bg-card hover:bg-accent/50 transition-colors"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-medium truncate">{cyclus.cyclus_name}</span>
                                <Badge variant="secondary" className="shrink-0">
                                  {cyclus.open_slots}/{cyclus.total_slots} {t('openSlots.open', 'open')}
                                </Badge>
                              </div>
                              {cyclus.next_slot && (
                                <p className="text-sm text-muted-foreground mt-1">
                                  {t('openSlots.next', 'Next')}: {formatSlotTime(cyclus.next_slot.start_time)}
                                  {cyclus.lesson_title && (
                                    <span className="ml-1">· {cyclus.lesson_title}</span>
                                  )}
                                </p>
                              )}
                            </div>
                          </div>
                          {cyclus.next_slot && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="mt-3 w-full"
                              onClick={() => handleBookPlayer({
                                id: cyclus.next_slot!.id,
                                start_time: cyclus.next_slot!.start_time,
                                end_time: '',
                                lesson_id: cyclus.next_slot!.lesson_id,
                                lesson_title: cyclus.lesson_title,
                                max_participants: cyclus.next_slot!.max_participants,
                                booked_count: cyclus.next_slot!.max_participants - cyclus.next_slot!.available_spots,
                                available_spots: cyclus.next_slot!.available_spots,
                                cyclus_id: cyclus.cyclus_id,
                              })}
                            >
                              <UserPlus className="h-4 w-4 mr-2" />
                              {t('openSlots.bookPlayer', 'Book player')}
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Individual Slots */}
                {individualSlots.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
                      <Calendar className="h-4 w-4" />
                      {t('openSlots.individualSlots', 'Individual Slots')}
                    </h3>
                    <div className="space-y-3">
                      {individualSlots.map(slot => (
                        <div
                          key={slot.id}
                          className="border rounded-lg p-4 bg-card hover:bg-accent/50 transition-colors"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-medium">{formatSlotTime(slot.start_time)}</span>
                                <Badge variant="secondary" className="shrink-0">
                                  {slot.available_spots} {slot.available_spots === 1 
                                    ? t('openSlots.spotOpen', 'spot open') 
                                    : t('openSlots.spotsOpen', 'spots open')}
                                </Badge>
                              </div>
                              <p className="text-sm text-muted-foreground mt-1">
                                {slot.lesson_title || t('openSlots.noLesson', 'No lesson linked')}
                              </p>
                            </div>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="mt-3 w-full"
                            onClick={() => handleBookPlayer(slot)}
                          >
                            <UserPlus className="h-4 w-4 mr-2" />
                            {t('openSlots.bookPlayer', 'Book player')}
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </ScrollArea>

          {hasOpenSlots && (
            <div className="mt-4 pt-4 border-t">
              <Button variant="ghost" className="w-full" onClick={handleViewCalendar}>
                {t('openSlots.viewCalendar', 'View full calendar')}
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {selectedSlot && (
        <BookForPlayerDialog
          open={bookDialogOpen}
          onOpenChange={setBookDialogOpen}
          trainerId={trainerId}
          slot={{
            id: selectedSlot.id,
            start_time: selectedSlot.start_time,
            end_time: selectedSlot.end_time,
            lesson_id: selectedSlot.lesson_id,
            cyclus_id: selectedSlot.cyclus_id,
          }}
          lesson={selectedSlot.lesson_title ? {
            id: selectedSlot.lesson_id || '',
            title: selectedSlot.lesson_title,
            price: 0,
            location: null,
          } : null}
          onBookingCreated={handleBookingCreated}
        />
      )}
    </>
  );
}
