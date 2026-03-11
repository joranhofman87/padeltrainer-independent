import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { format, parseISO, isSameDay } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { Calendar, Clock, MapPin, Users, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import { formatPrice } from '@/lib/pricing';

interface SlotData {
  id: string;
  start_time: string;
  end_time: string;
  cyclus_id: string | null;
  cyclus_name: string | null;
  court_type: string | null;
  location_name: string | null;
  price_per_session: number | null;
  max_participants: number;
  allow_single_booking: boolean;
  spots_left: number;
}

interface CycleGroup {
  cyclus_id: string;
  cyclus_name: string;
  slots: SlotData[];
  firstDate: Date;
  lastDate: Date;
  sessionCount: number;
  dayPattern: string;
  timePattern: string;
  location_name: string | null;
  minSpotsLeft: number;
  totalPrice: number | null;
}

interface DayGroup {
  date: Date;
  slots: SlotData[];
}

interface TrainerOpenSlotsProps {
  trainerId: string;
  trainerSlug?: string;
}

export function TrainerOpenSlots({ trainerId, trainerSlug }: TrainerOpenSlotsProps) {
  const { t, i18n } = useTranslation(['trainer', 'common']);
  const navigate = useNavigate();
  const [dayGroups, setDayGroups] = useState<DayGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const localizePath = useLocalizedPathFn();
  const dateLocale = i18n.language === 'nl' ? nl : enUS;

  const [cycleGroups, setCycleGroups] = useState<CycleGroup[]>([]);

  useEffect(() => {
    fetchOpenSlots();
  }, [trainerId]);

  const fetchOpenSlots = async () => {
    try {
      const { data: slotsData } = await supabase
        .from('availability_slots')
        .select(`
          id,
          start_time,
          end_time,
          cyclus_id,
          cyclus_name,
          court_type,
          is_marked_full,
          is_public,
          price_per_session,
          max_participants,
          allow_single_booking,
          location_id,
          locations:location_id(name)
        `)
        .eq('trainer_id', trainerId)
        .eq('is_marked_full', false)
        .eq('is_public', true)
        .gte('start_time', new Date().toISOString())
        .order('start_time', { ascending: true })
        .limit(50);

      if (!slotsData || slotsData.length === 0) {
        setDayGroups([]);
        setCycleGroups([]);
        setLoading(false);
        return;
      }

      // Fetch booking counts
      const slotIds = slotsData.map(s => s.id);
      const { data: bookingsData } = await supabase
        .from('bookings')
        .select('slot_id')
        .in('slot_id', slotIds)
        .in('status', ['pending', 'confirmed']);

      const bookingCounts: Record<string, number> = {};
      bookingsData?.forEach(b => {
        bookingCounts[b.slot_id] = (bookingCounts[b.slot_id] || 0) + 1;
      });

      // Filter to slots with availability and map
      const availableSlots: SlotData[] = slotsData
        .filter(s => {
          const maxParticipants = (s as any).max_participants || 4;
          const booked = bookingCounts[s.id] || 0;
          return booked < maxParticipants;
        })
        .map(s => {
          const maxParticipants = (s as any).max_participants || 4;
          const booked = bookingCounts[s.id] || 0;
          return {
            id: s.id,
            start_time: s.start_time,
            end_time: s.end_time,
            cyclus_id: s.cyclus_id,
            cyclus_name: s.cyclus_name,
            court_type: s.court_type,
            location_name: (s.locations as any)?.name || null,
            price_per_session: (s as any).price_per_session || null,
            max_participants: maxParticipants,
            allow_single_booking: (s as any).allow_single_booking || false,
            spots_left: maxParticipants - booked,
          };
        });

      // Separate individual slots vs cycle-grouped slots
      const individualSlots: SlotData[] = [];
      const cycleSlotMap = new Map<string, SlotData[]>();

      for (const slot of availableSlots) {
        if (slot.cyclus_id) {
          const existing = cycleSlotMap.get(slot.cyclus_id) || [];
          existing.push(slot);
          cycleSlotMap.set(slot.cyclus_id, existing);
          // Also show as individual bookable rows if single booking is allowed
          if (slot.allow_single_booking) {
            individualSlots.push(slot);
          }
        } else {
          individualSlots.push(slot);
        }
      }

      // Build cycle groups
      const builtCycleGroups: CycleGroup[] = [];
      for (const [cyclusId, slots] of cycleSlotMap) {
        const sorted = slots.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
        const firstSlot = sorted[0];
        const lastSlot = sorted[sorted.length - 1];
        const firstDate = parseISO(firstSlot.start_time);
        const dayName = format(firstDate, 'EEEE', { locale: dateLocale });
        const timeStart = format(firstDate, 'HH:mm');
        const timeEnd = format(parseISO(firstSlot.end_time), 'HH:mm');

        builtCycleGroups.push({
          cyclus_id: cyclusId,
          cyclus_name: firstSlot.cyclus_name || cyclusId,
          slots: sorted,
          firstDate,
          lastDate: parseISO(lastSlot.start_time),
          sessionCount: sorted.length,
          dayPattern: dayName,
          timePattern: `${timeStart} - ${timeEnd}`,
          location_name: firstSlot.location_name,
          minSpotsLeft: Math.min(...sorted.map(s => s.spots_left)),
          totalPrice: firstSlot.price_per_session ? Math.round(firstSlot.price_per_session * sorted.length * 100) / 100 : null,
        });
      }
      setCycleGroups(builtCycleGroups);

      // Group individual slots by day
      const groups: DayGroup[] = [];
      for (const slot of individualSlots) {
        const slotDate = parseISO(slot.start_time);
        const existingGroup = groups.find(g => isSameDay(g.date, slotDate));
        if (existingGroup) {
          existingGroup.slots.push(slot);
        } else {
          groups.push({ date: slotDate, slots: [slot] });
        }
      }

      setDayGroups(groups);
    } catch (error) {
      console.error('Error fetching open slots:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading || (dayGroups.length === 0 && cycleGroups.length === 0)) {
    return null;
  }

  const totalSlots = dayGroups.reduce((sum, g) => sum + g.slots.length, 0) + cycleGroups.length;
  const displayGroups = showAll ? dayGroups : dayGroups.slice(0, 3);
  const bookUrl = localizePath(`/book/${trainerSlug || trainerId}`);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5 text-primary" />
            {t('common:availableSlots', 'Available Slots')}
          </CardTitle>
          <Badge variant="secondary" className="text-sm">
            {totalSlots} {totalSlots === 1 ? t('common:slot', 'slot') : t('common:slots', 'slots')}
          </Badge>
        </div>
        <CardDescription>
          {t('common:upcomingAvailability', 'Upcoming available time slots')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Cycle summary cards */}
        {cycleGroups.map(cg => (
          <div
            key={cg.cyclus_id}
            className="p-4 border rounded-lg hover:border-primary/50 transition-colors cursor-pointer space-y-2"
            onClick={() => navigate(bookUrl)}
          >
            <div className="flex items-center justify-between">
              <h4 className="font-semibold text-sm">{cg.cyclus_name}</h4>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                {format(cg.firstDate, 'd MMM', { locale: dateLocale })} – {format(cg.lastDate, 'd MMM', { locale: dateLocale })}
              </span>
              <span>{cg.sessionCount} {t('cycles:form.sessions', 'sessions')}</span>
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {cg.dayPattern} {cg.timePattern}
              </span>
              {cg.location_name && (
                <span className="flex items-center gap-1">
                  <MapPin className="h-3 w-3" />
                  {cg.location_name}
                </span>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Users className="h-3 w-3" />
                {cg.minSpotsLeft} {cg.minSpotsLeft === 1 ? t('common:spotLeft', 'spot left') : t('common:spotsLeft', 'spots left')}
              </span>
              {cg.totalPrice != null && cg.totalPrice > 0 && (
                <Badge variant="secondary" className="font-semibold">
                  {formatPrice(cg.totalPrice)}
                </Badge>
              )}
            </div>
          </div>
        ))}

        {/* Individual slots grouped by day */}
        {displayGroups.map(group => (
          <div key={group.date.toISOString()} className="space-y-2">
            <h4 className="font-medium text-sm text-muted-foreground uppercase tracking-wide">
              {format(group.date, 'EEEE d MMMM', { locale: dateLocale })}
            </h4>
            <div className="space-y-2">
              {group.slots.map(slot => (
                <div
                  key={slot.id}
                  className="flex items-center justify-between p-3 border rounded-lg hover:border-primary/50 transition-colors cursor-pointer"
                  onClick={() => navigate(bookUrl)}
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="text-center min-w-[60px]">
                      <p className="font-semibold text-sm">
                        {format(parseISO(slot.start_time), 'HH:mm')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {format(parseISO(slot.end_time), 'HH:mm')}
                      </p>
                    </div>
                    <div className="flex-1 min-w-0">
                      {slot.cyclus_name && (
                        <p className="text-xs text-muted-foreground truncate">{slot.cyclus_name}</p>
                      )}
                      <div className="flex flex-wrap gap-2 mt-1">
                        {slot.location_name && (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <MapPin className="h-3 w-3" />
                            {slot.location_name}
                          </span>
                        )}
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Users className="h-3 w-3" />
                          {slot.spots_left} {slot.spots_left === 1 ? t('common:spotLeft', 'spot left') : t('common:spotsLeft', 'spots left')}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 ml-2">
                    {slot.price_per_session != null && slot.price_per_session > 0 && (
                      <Badge variant="secondary" className="font-semibold">
                        {slot.allow_single_booking && slot.max_participants > 1
                          ? `${formatPrice(slot.price_per_session / slot.max_participants)}/spot`
                          : formatPrice(slot.price_per_session)}
                      </Badge>
                    )}
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {dayGroups.length > 3 && !showAll && (
          <Button
            variant="outline"
            className="w-full"
            onClick={() => setShowAll(true)}
          >
            {t('common:showMore', 'Show more')} ({dayGroups.length - 3} {t('common:moreDays', 'more days')})
          </Button>
        )}

        <Button
          className="w-full"
          onClick={() => navigate(bookUrl)}
        >
          <Calendar className="h-4 w-4 mr-2" />
          {t('common:viewAllAndBook', 'View All & Book')}
        </Button>
      </CardContent>
    </Card>
  );
}
