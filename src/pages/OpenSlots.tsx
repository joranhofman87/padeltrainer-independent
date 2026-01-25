import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { Calendar, RotateCcw, UserPlus, ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { BookForPlayerDialog } from '@/components/trainer/BookForPlayerDialog';

interface CyclusGroup {
  cyclus_id: string;
  cyclus_name: string;
  lesson_title: string | null;
  open_slots: number;
  total_slots: number;
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

export default function OpenSlots() {
  const { t, i18n } = useTranslation('trainer');
  const { user, role, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [trainerId, setTrainerId] = useState<string | null>(null);
  const [cyclusGroups, setCyclusGroups] = useState<CyclusGroup[]>([]);
  const [individualSlots, setIndividualSlots] = useState<SlotData[]>([]);
  const [bookDialogOpen, setBookDialogOpen] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<SlotData | null>(null);
  const [expandedCycluses, setExpandedCycluses] = useState<Set<string>>(new Set());

  const dateLocale = i18n.language === 'nl' ? nl : enUS;

  // Auth is now handled by TrainerLayout

  useEffect(() => {
    if (user && role === 'trainer') {
      fetchTrainerId();
    }
  }, [user, role]);

  const fetchTrainerId = async () => {
    const { data } = await supabase
      .from('trainer_profiles')
      .select('id')
      .eq('user_id', user?.id)
      .maybeSingle();

    if (data) {
      setTrainerId(data.id);
      fetchOpenSlots(data.id);
    }
  };

  const fetchOpenSlots = async (tId: string) => {
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
        .eq('trainer_id', tId)
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
          } else {
            cyclusMap.set(slot.cyclus_id, {
              cyclus_id: slot.cyclus_id,
              cyclus_name: slotInfo?.cyclus_name || `Cyclus ${slot.cyclus_id.slice(0, 8)}`,
              lesson_title: slot.lesson_title,
              open_slots: 1,
              total_slots: 1,
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
    if (trainerId) {
      fetchOpenSlots(trainerId);
    }
    setBookDialogOpen(false);
    setSelectedSlot(null);
  };

  const toggleCyclus = (cyclusId: string) => {
    setExpandedCycluses(prev => {
      const next = new Set(prev);
      if (next.has(cyclusId)) {
        next.delete(cyclusId);
      } else {
        next.add(cyclusId);
      }
      return next;
    });
  };

  const formatSlotTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return format(date, 'EEE d MMM', { locale: dateLocale }) + ' ' + t('calendar.at', 'at') + ' ' + format(date, 'HH:mm');
  };

  const formatShortTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return format(date, 'EEE d MMM HH:mm', { locale: dateLocale });
  };

  const hasOpenSlots = cyclusGroups.length > 0 || individualSlots.length > 0;
  const totalOpenSlots = cyclusGroups.reduce((acc, c) => acc + c.open_slots, 0) + individualSlots.length;

  if (authLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <>
      {/* Sub-page Header */}
      <div className="border-b bg-background/60">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={() => navigate('/trainer')}>
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <h1 className="font-bold text-lg">{t('openSlots.title', 'Open Slots')}</h1>
              <Badge variant="secondary">{totalOpenSlots}</Badge>
            </div>
            <Button variant="outline" size="sm" onClick={() => navigate('/trainer/calendar')}>
              <Calendar className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">{t('openSlots.calendar', 'Calendar')}</span>
            </Button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        {loading ? (
          <div className="space-y-4">
            {[1, 2, 3, 4].map(i => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : !hasOpenSlots ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <Calendar className="h-16 w-16 text-muted-foreground mb-4" />
              <h2 className="text-xl font-semibold mb-2">
                {t('openSlots.noOpenSlots', 'No open slots available')}
              </h2>
              <p className="text-muted-foreground mb-6">
                {t('openSlots.noOpenSlotsDescription', 'All your training slots are either fully booked or marked as private.')}
              </p>
              <Button onClick={() => navigate('/trainer/calendar')}>
                {t('openSlots.createSlots', 'Create new slots')}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-8">
            {/* Training Cycles */}
            {cyclusGroups.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-4">
                  <RotateCcw className="h-5 w-5 text-muted-foreground" />
                  <h2 className="text-lg font-semibold">
                    {t('openSlots.trainingCycles', 'Training Cycles')}
                  </h2>
                  <Badge variant="outline">{cyclusGroups.length}</Badge>
                </div>
                <div className="space-y-3">
                  {cyclusGroups.map(cyclus => (
                    <Collapsible
                      key={cyclus.cyclus_id}
                      open={expandedCycluses.has(cyclus.cyclus_id)}
                      onOpenChange={() => toggleCyclus(cyclus.cyclus_id)}
                    >
                      <Card className="overflow-hidden">
                        <CollapsibleTrigger asChild>
                          <button className="w-full text-left">
                            <CardContent className="p-4 flex items-center justify-between hover:bg-accent/50 transition-colors">
                              <div className="flex items-center gap-3">
                                {expandedCycluses.has(cyclus.cyclus_id) ? (
                                  <ChevronDown className="h-5 w-5 text-muted-foreground shrink-0" />
                                ) : (
                                  <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" />
                                )}
                                <div>
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-medium">{cyclus.cyclus_name}</span>
                                    <Badge variant="secondary">
                                      {cyclus.open_slots} {t('openSlots.sessionsOpen', 'sessions open')}
                                    </Badge>
                                  </div>
                                  {cyclus.lesson_title && (
                                    <p className="text-sm text-muted-foreground mt-1">
                                      {cyclus.lesson_title}
                                    </p>
                                  )}
                                </div>
                              </div>
                            </CardContent>
                          </button>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <div className="border-t bg-muted/30">
                            <div className="divide-y">
                              {cyclus.slots.map(slot => (
                                <div
                                  key={slot.id}
                                  className="p-4 flex items-center justify-between hover:bg-accent/30 transition-colors"
                                >
                                  <div>
                                    <p className="font-medium">{formatShortTime(slot.start_time)}</p>
                                    <p className="text-sm text-muted-foreground">
                                      {slot.available_spots}/{slot.max_participants} {t('openSlots.spotsAvailable', 'spots available')}
                                    </p>
                                  </div>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleBookPlayer(slot);
                                    }}
                                  >
                                    <UserPlus className="h-4 w-4 mr-2" />
                                    {t('openSlots.bookPlayer', 'Book player')}
                                  </Button>
                                </div>
                              ))}
                            </div>
                          </div>
                        </CollapsibleContent>
                      </Card>
                    </Collapsible>
                  ))}
                </div>
              </section>
            )}

            {/* Individual Slots */}
            {individualSlots.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-4">
                  <Calendar className="h-5 w-5 text-muted-foreground" />
                  <h2 className="text-lg font-semibold">
                    {t('openSlots.individualSlots', 'Individual Slots')}
                  </h2>
                  <Badge variant="outline">{individualSlots.length}</Badge>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {individualSlots.map(slot => (
                    <Card key={slot.id} className="hover:shadow-md transition-shadow">
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-2 mb-3">
                          <div>
                            <p className="font-medium">{formatSlotTime(slot.start_time)}</p>
                            <p className="text-sm text-muted-foreground">
                              {slot.lesson_title || t('openSlots.noLesson', 'No lesson linked')}
                            </p>
                          </div>
                          <Badge variant="secondary">
                            {slot.available_spots} {slot.available_spots === 1 
                              ? t('openSlots.spotOpen', 'spot') 
                              : t('openSlots.spotsOpen', 'spots')}
                          </Badge>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full"
                          onClick={() => handleBookPlayer(slot)}
                        >
                          <UserPlus className="h-4 w-4 mr-2" />
                          {t('openSlots.bookPlayer', 'Book player')}
                        </Button>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </main>

      {/* Book Player Dialog */}
      {selectedSlot && trainerId && (
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
