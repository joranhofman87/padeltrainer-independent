import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { Calendar, RotateCcw, UserPlus, ArrowLeft, ChevronDown, ChevronRight, MapPin, Eye, EyeOff } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { BookForPlayerDialog } from '@/components/trainer/BookForPlayerDialog';
import { useToast } from '@/hooks/use-toast';
import { logger } from '@/lib/logger';

interface CyclusGroup {
  cyclus_id: string;
  cyclus_name: string;
  open_slots: number;
  total_slots: number;
  slots: SlotData[];
  is_public: boolean;
  day_time: string;
  first_date: string;
  last_date: string;
}

interface SlotData {
  id: string;
  start_time: string;
  end_time: string;
  max_participants: number;
  booked_count: number;
  available_spots: number;
  cyclus_id: string | null;
  is_public: boolean;
  location_name: string | null;
}

export default function OpenSlots() {
  const { t, i18n } = useTranslation('trainer');
  const { user, role, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [trainerId, setTrainerId] = useState<string | null>(null);
  const [cyclusGroups, setCyclusGroups] = useState<CyclusGroup[]>([]);
  const [individualSlots, setIndividualSlots] = useState<SlotData[]>([]);
  const [bookDialogOpen, setBookDialogOpen] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<SlotData | null>(null);
  const [expandedCycluses, setExpandedCycluses] = useState<Set<string>>(new Set());

  const dateLocale = i18n.language === 'nl' ? nl : enUS;

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
      const { data: slots, error } = await supabase
        .from('availability_slots')
        .select(`
          id,
          start_time,
          end_time,
          max_participants,
          cyclus_id,
          cyclus_name,
          is_marked_full,
          is_public,
          location_id,
          locations:location_id(name)
        `)
        .eq('trainer_id', tId)
        .eq('is_marked_full', false)
        .gte('start_time', new Date().toISOString())
        .order('start_time', { ascending: true });

      if (error) throw error;

      const slotIds = slots?.map(s => s.id) || [];
      const { data: bookings } = await supabase
        .from('bookings')
        .select('slot_id, status')
        .in('slot_id', slotIds)
        .in('status', ['confirmed', 'pending']);

      const bookingCounts: Record<string, number> = {};
      bookings?.forEach(b => {
        bookingCounts[b.slot_id] = (bookingCounts[b.slot_id] || 0) + 1;
      });

      const processedSlots: SlotData[] = (slots || []).map(slot => {
        const maxParticipants = slot.max_participants || 4;
        const bookedCount = bookingCounts[slot.id] || 0;
        return {
          id: slot.id,
          start_time: slot.start_time,
          end_time: slot.end_time,
          max_participants: maxParticipants,
          booked_count: bookedCount,
          available_spots: maxParticipants - bookedCount,
          cyclus_id: slot.cyclus_id,
          is_public: slot.is_public ?? true,
          location_name: (slot.locations as any)?.name || null,
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
            // Update is_public: true only if ALL slots are public
            if (!slot.is_public) existing.is_public = false;
            // Update date range
            if (slot.start_time > existing.last_date) existing.last_date = slot.start_time;
            if (slot.start_time < existing.first_date) existing.first_date = slot.start_time;
          } else {
            cyclusMap.set(slot.cyclus_id, {
              cyclus_id: slot.cyclus_id,
              cyclus_name: (slots?.find(s => s.id === slot.id) as any)?.cyclus_name || `Cyclus ${slot.cyclus_id.slice(0, 8)}`,
              open_slots: 1,
              total_slots: 1,
              slots: [slot],
              is_public: slot.is_public,
              day_time: format(new Date(slot.start_time), 'EEEE HH:mm', { locale: dateLocale }),
              first_date: slot.start_time,
              last_date: slot.start_time,
            });
          }
        } else {
          individual.push(slot);
        }
      });

      setCyclusGroups(Array.from(cyclusMap.values()));
      setIndividualSlots(individual);
    } catch (error) {
      logger.error('Error fetching open slots', error as Error, { component: 'OpenSlots', trainerId: tId });
    } finally {
      setLoading(false);
    }
  };

  const handleBookPlayer = (slot: SlotData) => {
    setSelectedSlot(slot);
    setBookDialogOpen(true);
  };

  const handleBookingCreated = () => {
    if (trainerId) fetchOpenSlots(trainerId);
    setBookDialogOpen(false);
    setSelectedSlot(null);
  };

  const toggleCyclus = (cyclusId: string) => {
    setExpandedCycluses(prev => {
      const next = new Set(prev);
      next.has(cyclusId) ? next.delete(cyclusId) : next.add(cyclusId);
      return next;
    });
  };

  // --- Visibility toggle handlers ---
  const toggleSlotVisibility = useCallback(async (slotId: string, newValue: boolean) => {
    const { error } = await supabase
      .from('availability_slots')
      .update({ is_public: newValue })
      .eq('id', slotId);

    if (error) {
      logger.error('Error toggling slot visibility', error, { slotId });
      return;
    }

    toast({ description: newValue ? t('openSlots.slotVisible') : t('openSlots.slotHidden') });

    // Optimistic update
    setIndividualSlots(prev => prev.map(s => s.id === slotId ? { ...s, is_public: newValue } : s));
    setCyclusGroups(prev => prev.map(g => {
      const updatedSlots = g.slots.map(s => s.id === slotId ? { ...s, is_public: newValue } : s);
      return { ...g, slots: updatedSlots, is_public: updatedSlots.every(s => s.is_public) };
    }));
  }, [t, toast]);

  const toggleCyclusVisibility = useCallback(async (cyclusId: string, newValue: boolean) => {
    const group = cyclusGroups.find(g => g.cyclus_id === cyclusId);
    if (!group) return;

    const slotIds = group.slots.map(s => s.id);
    const { error } = await supabase
      .from('availability_slots')
      .update({ is_public: newValue })
      .in('id', slotIds);

    if (error) {
      logger.error('Error toggling cyclus visibility', error, { cyclusId });
      return;
    }

    toast({ description: newValue ? t('openSlots.cyclusVisible') : t('openSlots.cyclusHidden') });

    setCyclusGroups(prev => prev.map(g =>
      g.cyclus_id === cyclusId
        ? { ...g, is_public: newValue, slots: g.slots.map(s => ({ ...s, is_public: newValue })) }
        : g
    ));
  }, [cyclusGroups, t, toast]);

  const toggleAllVisibility = useCallback(async (newValue: boolean) => {
    if (!trainerId) return;

    // Get all slot IDs currently displayed
    const allSlotIds = [
      ...individualSlots.map(s => s.id),
      ...cyclusGroups.flatMap(g => g.slots.map(s => s.id)),
    ];

    if (allSlotIds.length === 0) return;

    const { error } = await supabase
      .from('availability_slots')
      .update({ is_public: newValue })
      .in('id', allSlotIds);

    if (error) {
      logger.error('Error toggling all visibility', error);
      return;
    }

    toast({ description: newValue ? t('openSlots.allVisible') : t('openSlots.allHidden') });

    setIndividualSlots(prev => prev.map(s => ({ ...s, is_public: newValue })));
    setCyclusGroups(prev => prev.map(g => ({
      ...g,
      is_public: newValue,
      slots: g.slots.map(s => ({ ...s, is_public: newValue })),
    })));
  }, [trainerId, individualSlots, cyclusGroups, t, toast]);

  const formatSlotTimeRange = (startStr: string, endStr: string) => {
    const start = new Date(startStr);
    const end = new Date(endStr);
    return format(start, 'EEE d MMM HH:mm', { locale: dateLocale }) + ' – ' + format(end, 'HH:mm');
  };

  const formatShortTime = (startStr: string, endStr: string) => {
    const start = new Date(startStr);
    const end = new Date(endStr);
    return format(start, 'EEE d MMM HH:mm', { locale: dateLocale }) + ' – ' + format(end, 'HH:mm');
  };

  const hasOpenSlots = cyclusGroups.length > 0 || individualSlots.length > 0;
  const totalOpenSlots = cyclusGroups.reduce((acc, c) => acc + c.open_slots, 0) + individualSlots.length;
  const allPublic = [...individualSlots, ...cyclusGroups.flatMap(g => g.slots)].every(s => s.is_public);
  const anySlots = totalOpenSlots > 0;

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
              <Button variant="ghost" size="icon" onClick={() => navigate('/app/trainer')}>
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <h1 className="font-bold text-lg">{t('openSlots.title', 'Open Slots')}</h1>
              <Badge variant="secondary">{totalOpenSlots}</Badge>
            </div>
            <div className="flex items-center gap-2">
              {anySlots && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => toggleAllVisibility(!allPublic)}
                >
                  {allPublic ? <EyeOff className="h-4 w-4 sm:mr-2" /> : <Eye className="h-4 w-4 sm:mr-2" />}
                  <span className="hidden sm:inline">{allPublic ? t('openSlots.hideAll') : t('openSlots.showAll')}</span>
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => navigate('/app/trainer/calendar')}>
                <Calendar className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">{t('openSlots.calendar', 'Calendar')}</span>
              </Button>
            </div>
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
                {t('openSlots.noOpenSlotsDescription')}
              </p>
              <Button onClick={() => navigate('/app/trainer/calendar')}>
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
                        <div className="flex items-center">
                          <CollapsibleTrigger asChild>
                            <button className="flex-1 text-left">
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
                                      {!cyclus.is_public && (
                                        <Badge variant="outline" className="text-xs">
                                          <EyeOff className="h-3 w-3 mr-1" />
                                          {t('openSlots.hiddenFromPlayers')}
                                        </Badge>
                                      )}
                                    </div>
                                    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
                                      <p className="text-sm text-muted-foreground capitalize">{cyclus.day_time}</p>
                                      <p className="text-sm text-muted-foreground capitalize">{cyclus.day_time}</p>
                                      <p className="text-sm text-muted-foreground">
                                        {format(new Date(cyclus.first_date), 'd MMM', { locale: dateLocale })} – {format(new Date(cyclus.last_date), 'd MMM', { locale: dateLocale })}
                                      </p>
                                    </div>
                                  </div>
                                </div>
                              </CardContent>
                            </button>
                          </CollapsibleTrigger>
                          <div className="pr-4" onClick={e => e.stopPropagation()}>
                            <Switch
                              checked={cyclus.is_public}
                              onCheckedChange={(val) => toggleCyclusVisibility(cyclus.cyclus_id, val)}
                            />
                          </div>
                        </div>
                        <CollapsibleContent>
                          <div className="border-t bg-muted/30">
                            <div className="divide-y">
                              {cyclus.slots.map(slot => (
                                <div
                                  key={slot.id}
                                  className="p-4 flex items-center justify-between hover:bg-accent/30 transition-colors"
                                >
                                  <div className="flex-1">
                                    <p className="font-medium">{formatShortTime(slot.start_time, slot.end_time)}</p>
                                    <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1">
                                      <span className="text-sm text-muted-foreground">
                                        {slot.available_spots}/{slot.max_participants} {t('openSlots.spotsAvailable')}
                                      </span>
                                      {slot.location_name && (
                                        <span className="flex items-center gap-1 text-sm text-muted-foreground">
                                          <MapPin className="h-3 w-3" />
                                          {slot.location_name}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <Switch
                                      checked={slot.is_public}
                                      onCheckedChange={(val) => toggleSlotVisibility(slot.id, val)}
                                    />
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
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <div className="flex-1 min-w-0">
                            <p className="font-medium">{formatSlotTimeRange(slot.start_time, slot.end_time)}</p>
                            {slot.location_name && (
                              <p className="flex items-center gap-1 text-sm text-muted-foreground mt-1">
                                <MapPin className="h-3 w-3 shrink-0" />
                                {slot.location_name}
                              </p>
                            )}
                          </div>
                          <Switch
                            checked={slot.is_public}
                            onCheckedChange={(val) => toggleSlotVisibility(slot.id, val)}
                          />
                        </div>
                        <div className="flex items-center justify-between gap-2 mb-3">
                          <div className="flex flex-wrap gap-1">
                            <Badge variant="secondary">
                              {slot.available_spots} {slot.available_spots === 1
                                ? t('openSlots.spotOpen', 'spot')
                                : t('openSlots.spotsOpen', 'spots')}
                            </Badge>
                            {!slot.is_public && (
                              <Badge variant="outline" className="text-xs">
                                <EyeOff className="h-3 w-3 mr-1" />
                                {t('openSlots.hiddenFromPlayers')}
                              </Badge>
                            )}
                          </div>
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
            lesson_id: null,
            cyclus_id: selectedSlot.cyclus_id,
          }}
          lesson={null}
          onBookingCreated={handleBookingCreated}
        />
      )}
    </>
  );
}
