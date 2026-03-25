import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { format, parseISO, isSameDay } from 'date-fns';
import { nl, enUS, es, de, fr } from 'date-fns/locale';
import { Calendar, Clock, MapPin, Users } from 'lucide-react';
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
  trainer_name: string | null;
  trainer_slug: string | null;
  price_per_session: number | null;
  total_price: number | null;
  max_participants: number;
  allow_single_booking: boolean;
  spots_left: number;
}

interface DayGroup {
  date: Date;
  slots: SlotData[];
}

interface AcademyPublicOpenSlotsProps {
  academyId: string;
  academySlug: string;
}

const DATE_LOCALES: Record<string, typeof enUS> = { nl, en: enUS, es, de, fr };

export function AcademyPublicOpenSlots({ academyId, academySlug }: AcademyPublicOpenSlotsProps) {
  const { t, i18n } = useTranslation(['trainer', 'common']);
  const navigate = useNavigate();
  const [dayGroups, setDayGroups] = useState<DayGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const localizePath = useLocalizedPathFn();
  const dateLocale = DATE_LOCALES[i18n.language] || enUS;

  useEffect(() => {
    fetchOpenSlots();
  }, [academyId]);

  const fetchOpenSlots = async () => {
    try {
      // Fetch active trainer IDs for this academy
      const { data: trainerRows } = await supabase
        .from('academy_trainers')
        .select('trainer_profile_id')
        .eq('academy_profile_id', academyId)
        .eq('status', 'active');

      const trainerIds = (trainerRows || []).map(t => t.trainer_profile_id);

      // Build OR filter: academy-level slots OR trainer-owned slots
      const orFilter = trainerIds.length > 0
        ? `academy_profile_id.eq.${academyId},trainer_id.in.(${trainerIds.join(',')})`
        : `academy_profile_id.eq.${academyId}`;

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
          total_price,
          max_participants,
          allow_single_booking,
          location_id,
          trainer_id,
          locations:location_id(name),
          trainer_profiles:trainer_id(
            id,
            slug,
            user_id,
            profiles:user_id(full_name)
          )
        `)
        .or(orFilter)
        .eq('is_marked_full', false)
        .eq('is_public', true)
        .gte('start_time', new Date().toISOString())
        .order('start_time', { ascending: true })
        .limit(50);

      if (!slotsData || slotsData.length === 0) {
        setDayGroups([]);
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

      const availableSlots: SlotData[] = slotsData
        .filter(s => {
          const maxP = (s as any).max_participants || 4;
          return (bookingCounts[s.id] || 0) < maxP;
        })
        .map(s => {
          const maxP = (s as any).max_participants || 4;
          const booked = bookingCounts[s.id] || 0;
          const trainerProfile = s.trainer_profiles as any;
          const trainerName = trainerProfile?.profiles?.full_name || null;
          const trainerSlug = trainerProfile?.slug || null;
          return {
            id: s.id,
            start_time: s.start_time,
            end_time: s.end_time,
            cyclus_id: s.cyclus_id,
            cyclus_name: s.cyclus_name,
            court_type: s.court_type,
            location_name: (s.locations as any)?.name || null,
            trainer_name: trainerName,
            trainer_slug: trainerSlug,
            price_per_session: (s as any).price_per_session || null,
            total_price: (s as any).total_price || null,
            max_participants: maxP,
            allow_single_booking: (s as any).allow_single_booking || false,
            spots_left: maxP - booked,
          };
        });

      // Group by day
      const groups: DayGroup[] = [];
      for (const slot of availableSlots) {
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
      logger.error('Error fetching academy open slots', error instanceof Error ? error : new Error(String(error)), { component: 'AcademyPublicOpenSlots' });
    } finally {
      setLoading(false);
    }
  };

  if (loading || dayGroups.length === 0) {
    return null;
  }

  const totalSlots = dayGroups.reduce((sum, g) => sum + g.slots.length, 0);
  const displayGroups = showAll ? dayGroups : dayGroups.slice(0, 3);

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
        {displayGroups.map(group => (
          <div key={group.date.toISOString()} className="space-y-2">
            <h4 className="font-medium text-sm text-muted-foreground uppercase tracking-wide">
              {format(group.date, 'EEEE d MMMM', { locale: dateLocale })}
            </h4>
            <div className="space-y-2">
              {group.slots.map(slot => (
                <div
                  key={slot.id}
                  className="flex items-center justify-between p-3 border rounded-lg transition-colors"
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
                      {slot.trainer_name && (
                        <p className="text-sm font-medium truncate">{slot.trainer_name}</p>
                      )}
                      <div className="flex flex-wrap gap-2 mt-1">
                        <Badge variant={slot.cyclus_id ? 'default' : 'outline'} className="text-xs">
                          {slot.cyclus_name || t('common:singleSession', 'Single session')}
                        </Badge>
                        {slot.court_type && (
                          <Badge variant="outline" className="text-xs">
                            {slot.court_type === 'indoor' ? '🏠' : '☀️'}{' '}
                            {slot.court_type === 'indoor' ? 'Indoor' : 'Outdoor'}
                          </Badge>
                        )}
                      </div>
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
                  <div className="flex items-center gap-3 ml-2">
                    <div className="text-right">
                      {slot.price_per_session != null && slot.price_per_session > 0 && (
                        <p className="text-sm font-semibold">{formatPrice(slot.price_per_session)}<span className="text-xs font-normal text-muted-foreground">/{t('common:session', 'session')}</span></p>
                      )}
                      {slot.cyclus_id && slot.total_price != null && slot.total_price > 0 && (
                        <p className="text-xs text-muted-foreground">{t('common:total', 'Total')}: {formatPrice(slot.total_price)}</p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      onClick={() => {
                        if (slot.cyclus_id) {
                          navigate(localizePath(`/academies/${academySlug}/register/${slot.cyclus_id}`));
                        } else if (slot.trainer_slug) {
                          navigate(localizePath(`/book/${slot.trainer_slug}`));
                        }
                      }}
                    >
                      {t('common:book', 'Book')}
                    </Button>
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
      </CardContent>
    </Card>
  );
}
