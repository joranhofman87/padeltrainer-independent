import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { format, parseISO } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { Search, Users, Eye, EyeOff, Euro, Trash2 } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { CAPACITY_OCCUPYING_STATUSES } from '@/lib/lessons';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { logger } from '@/lib/logger';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { useTableSort } from '@/hooks/useTableSort';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import { formatPrice } from '@/lib/pricing';
import { cn } from '@/lib/utils';
import { syncInvoicesAfterPriceChange } from '@/lib/invoiceSync';
import {
  computeCyclusGroupPaymentStatus,
  matchesPaidFilter,
  paymentStatusBadgeVariant,
  type CyclusGroupPaymentStatus,
  type PaidFilterValue,
} from '@/lib/cyclusGroupPayment';

interface CyclusGroup {
  group_key: string; // composite: cyclus_id + trainer_id
  cyclus_id: string;
  cyclus_name: string;
  trainer_name: string;
  trainer_id: string;
  location_name: string | null;
  day_time: string;
  period_start: string;
  period_end: string;
  sessions: number;
  player_names: string[];
  player_count: number;
  price_per_session: number | null;
  max_participants: number;
  max_booked: number;
  /** True when any slot in the cyclus is public (showcased as bookable on the profile). */
  is_public: boolean;
  first_slot_id: string | null;
  status: string;
  type: string;
  has_slots: boolean;
  payment_status_summary: CyclusGroupPaymentStatus;
}

type TimeFilter = 'current' | 'future' | 'past' | 'all';

interface AcademyCyclusOverviewProps {
  /** Deep link from slot detail when cyclus_id has no cycles row (bulk recurring group). */
  highlightCyclusId?: string | null;
}

export default function AcademyCyclusOverview({ highlightCyclusId }: AcademyCyclusOverviewProps = {}) {
  const { t, i18n } = useTranslation('trainer');
  const navigate = useNavigate();
  const { activeAcademy } = useAcademyContext();
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState<CyclusGroup[]>([]);

  const { toast } = useToast();

  // Filters
  const [search, setSearch] = useState('');
  const [filterTrainer, setFilterTrainer] = useState('all');
  const [filterLocation, setFilterLocation] = useState('all');
  const [filterPaid, setFilterPaid] = useState<PaidFilterValue>('all');
  const [filterVisibility, setFilterVisibility] = useState<'all' | 'public' | 'private'>('all');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('current');

  // Bulk actions
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [priceDialogOpen, setPriceDialogOpen] = useState(false);
  const [bulkPrice, setBulkPrice] = useState('');

  const dateLocale = i18n.language === 'nl' ? nl : enUS;

  // Extract unique trainers/locations for filters
  const trainers = useMemo(() => {
    const map = new Map<string, string>();
    groups.forEach(g => { if (g.trainer_id) map.set(g.trainer_id, g.trainer_name); });
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [groups]);

  const locations = useMemo(() => {
    const set = new Set<string>();
    groups.forEach(g => { if (g.location_name) set.add(g.location_name); });
    return Array.from(set).sort();
  }, [groups]);

  useEffect(() => {
    if (activeAcademy) fetchCyclusData();
  }, [activeAcademy]);

  const fetchCyclusData = async () => {
    if (!activeAcademy) return;
    setLoading(true);

    try {
      // Get academy trainer IDs
      const { data: academyTrainers } = await supabase
        .from('academy_trainers')
        .select('trainer_profile_id')
        .eq('academy_profile_id', activeAcademy.id)
        .eq('status', 'active');

      const trainerIds = academyTrainers?.map(t => t.trainer_profile_id) || [];

      // Fetch trainer names
      const trainerNameMap: Record<string, string> = {};
      if (trainerIds.length > 0) {
        const { data: trainerProfiles } = await supabase
          .from('trainer_profiles' as any)
          .select('id, user_id')
          .in('id', trainerIds);

        const userIds = (trainerProfiles || []).map((tp: any) => tp.user_id).filter(Boolean);
        const nameMap: Record<string, string> = {};
        if (userIds.length > 0) {
          const { data: profiles } = await supabase
            .from('profiles' as any)
            .select('user_id, full_name')
            .in('user_id', userIds);
          (profiles || []).forEach((p: any) => {
            if (p.full_name) nameMap[p.user_id] = p.full_name;
          });
        }
        (trainerProfiles || []).forEach((tp: any) => {
          trainerNameMap[tp.id] = nameMap[tp.user_id] || 'Unknown';
        });
      }

      // 1. Fetch cycles from cycles table (academy-owned + trainer-owned)
      const { data: academyCycles } = await supabase
        .from('cycles')
        .select('id, name, owner_id, owner_type, status, type, start_date, end_date, price_per_session, total_price, location_id, locations:location_id(name)')
        .eq('owner_type', 'academy')
        .eq('owner_id', activeAcademy.id);

      let trainerCycles: any[] = [];
      if (trainerIds.length > 0) {
        const { data } = await supabase
          .from('cycles')
          .select('id, name, owner_id, owner_type, status, type, start_date, end_date, price_per_session, total_price, location_id, locations:location_id(name)')
          .eq('owner_type', 'trainer')
          .in('owner_id', trainerIds);
        trainerCycles = data || [];
      }

      const allCycles: any[] = [...(academyCycles || []), ...trainerCycles];

      // Deduplicate by id
      const cycleMap = new Map<string, any>();
      allCycles.forEach(c => cycleMap.set(c.id, c));

      const cycleIds = Array.from(cycleMap.keys());

      // 2. Fetch all slots that belong to any of these cycles OR have a cyclus_id (orphans)
      // Paginate to avoid Supabase 1000-row default limit
      const allSlots: any[] = [];
      if (trainerIds.length > 0) {
        let page = 0;
        const pageSize = 1000;
        while (true) {
          const { data: slots } = await supabase
            .from('availability_slots')
            .select(`
              id, start_time, end_time, max_participants, is_public,
              cyclus_id, cyclus_name, trainer_id,
              price_per_session,
              location_id, locations:location_id(name)
            `)
            .in('trainer_id', trainerIds)
            .not('cyclus_id', 'is', null)
            .order('start_time', { ascending: true })
            .range(page * pageSize, (page + 1) * pageSize - 1);
          allSlots.push(...(slots || []));
          if (!slots || slots.length < pageSize) break;
          page++;
        }
      }

      // Group slots by cyclus_id
      const slotsByCyclus = new Map<string, any[]>();
      allSlots.forEach(slot => {
        const cid = slot.cyclus_id as string;
        if (!slotsByCyclus.has(cid)) slotsByCyclus.set(cid, []);
        slotsByCyclus.get(cid)!.push(slot);
      });

      // 3. Fetch booking data for player names and payment status
      const slotIds = allSlots.map(s => s.id);
      const playerNamesMap: Record<string, string[]> = {};
      const bookingCountMap: Record<string, number> = {};
      const bookingsBySlot: Record<string, { status: string; payment_status: string | null; paid_externally: boolean | null }[]> = {};

      const paymentSummaryForSlots = (ids: string[]): CyclusGroupPaymentStatus => {
        const allBookings = ids.flatMap((id) => bookingsBySlot[id] || []);
        return computeCyclusGroupPaymentStatus(allBookings);
      };

      if (slotIds.length > 0) {
        for (let i = 0; i < slotIds.length; i += 500) {
          const chunk = slotIds.slice(i, i + 500);
          const { data: bookings } = await supabase
            .from('bookings')
            .select('slot_id, player_id, guest_player_id, status, payment_status, paid_externally')
            .in('slot_id', chunk)
            .in('status', [...CAPACITY_OCCUPYING_STATUSES]);

          const playerIds = [...new Set((bookings || []).map(b => b.player_id).filter(Boolean))] as string[];
          const playerNameLookup: Record<string, string> = {};
          if (playerIds.length > 0) {
            const { data: playerProfiles } = await supabase
              .from('profiles' as any)
              .select('id, full_name')
              .in('id', playerIds);
            (playerProfiles || []).forEach((p: any) => {
              if (p.full_name) playerNameLookup[p.id] = p.full_name;
            });
          }

          const guestIds = [...new Set((bookings || []).map(b => b.guest_player_id).filter(Boolean))] as string[];
          const guestNameLookup: Record<string, string> = {};
          if (guestIds.length > 0) {
            const { data: guestPlayers } = await supabase
              .from('guest_players' as any)
              .select('id, full_name')
              .in('id', guestIds);
            (guestPlayers || []).forEach((g: any) => {
              if (g.full_name) guestNameLookup[g.id] = g.full_name;
            });
          }

          bookings?.forEach(b => {
            bookingCountMap[b.slot_id] = (bookingCountMap[b.slot_id] || 0) + 1;
            if (!bookingsBySlot[b.slot_id]) bookingsBySlot[b.slot_id] = [];
            bookingsBySlot[b.slot_id].push({
              status: b.status,
              payment_status: b.payment_status ?? null,
              paid_externally: b.paid_externally ?? null,
            });
            const name = (b.player_id && playerNameLookup[b.player_id]) || (b.guest_player_id && guestNameLookup[b.guest_player_id]) || null;
            if (name) {
              if (!playerNamesMap[b.slot_id]) playerNamesMap[b.slot_id] = [];
              playerNamesMap[b.slot_id].push(name);
            }
          });
        }
      }

      // 4. Also fetch intake requests for cycles without slots (to show registered players)
      const intakePlayerMap: Record<string, string[]> = {};
      if (cycleIds.length > 0) {
        for (let i = 0; i < cycleIds.length; i += 500) {
          const chunk = cycleIds.slice(i, i + 500);
          const { data: intakes } = await supabase
            .from('intake_requests' as any)
            .select('cycle_id, player_id, guest_player_id')
            .in('cycle_id', chunk)
            .in('status', ['confirmed', 'booked', 'pending']);

          if (intakes && intakes.length > 0) {
            const intakePlayerIds = [...new Set(intakes.map((ir: any) => ir.player_id).filter(Boolean))] as string[];
            const intakePlayerLookup: Record<string, string> = {};
            if (intakePlayerIds.length > 0) {
              const { data: pp } = await supabase
                .from('profiles' as any)
                .select('id, full_name')
                .in('id', intakePlayerIds);
              (pp || []).forEach((p: any) => {
                if (p.full_name) intakePlayerLookup[p.id] = p.full_name;
              });
            }

            const intakeGuestIds = [...new Set(intakes.map((ir: any) => ir.guest_player_id).filter(Boolean))] as string[];
            const intakeGuestLookup: Record<string, string> = {};
            if (intakeGuestIds.length > 0) {
              const { data: gp } = await supabase
                .from('guest_players' as any)
                .select('id, full_name')
                .in('id', intakeGuestIds);
              (gp || []).forEach((g: any) => {
                if (g.full_name) intakeGuestLookup[g.id] = g.full_name;
              });
            }

            intakes.forEach((ir: any) => {
              const name = (ir.player_id && intakePlayerLookup[ir.player_id]) || (ir.guest_player_id && intakeGuestLookup[ir.guest_player_id]) || null;
              if (name) {
                if (!intakePlayerMap[ir.cycle_id]) intakePlayerMap[ir.cycle_id] = [];
                if (!intakePlayerMap[ir.cycle_id].includes(name)) {
                  intakePlayerMap[ir.cycle_id].push(name);
                }
              }
            });
          }
        }
      }

      // 5. Build grouped results — group by (cycle_id + trainer_id)
      const grouped: CyclusGroup[] = [];
      const processedCyclusIds = new Set<string>();

      // Process cycles from cycles table
      cycleMap.forEach((cycle, cycleId) => {
        processedCyclusIds.add(cycleId);
        const cyclusSlots = slotsByCyclus.get(cycleId) || [];

        // Sub-group slots by trainer_id
        const slotsByTrainer = new Map<string, any[]>();
        cyclusSlots.forEach((slot: any) => {
          const tid = slot.trainer_id || '';
          if (!slotsByTrainer.has(tid)) slotsByTrainer.set(tid, []);
          slotsByTrainer.get(tid)!.push(slot);
        });

        // If no slots at all, create one row with cycle-level data
        if (slotsByTrainer.size === 0) {
          // Skip empty registration intake forms — they're not real scheduled cycles
          if (cycle.type === 'registration') return;
          let trainerId = '';
          let trainerName = 'Unknown';
          if (cycle.owner_type === 'trainer' && trainerNameMap[cycle.owner_id]) {
            trainerId = cycle.owner_id;
            trainerName = trainerNameMap[cycle.owner_id];
          }
          const locationName = (cycle.locations as any)?.name || null;
          const periodStart = cycle.start_date || new Date().toISOString();
          const periodEnd = cycle.end_date || new Date().toISOString();
          const intakePlayers = intakePlayerMap[cycleId] || [];

          grouped.push({
            group_key: `${cycleId}::${trainerId}`,
            cyclus_id: cycleId,
            cyclus_name: cycle.name || cycleId,
            trainer_name: trainerName,
            trainer_id: trainerId,
            location_name: locationName,
            day_time: '—',
            period_start: periodStart,
            period_end: periodEnd,
            sessions: 0,
            player_names: intakePlayers.sort(),
            player_count: intakePlayers.length,
            price_per_session: cycle.price_per_session ?? null,
            max_participants: 4,
            max_booked: 0,
            first_slot_id: null,
            is_public: false,
            status: cycle.status || 'draft',
            type: cycle.type || 'cyclus',
            has_slots: false,
            payment_status_summary: 'no_players',
          });
        } else {
          const isRegistration = cycle.type === 'registration';

          // For registration cycles each weekly recurring slot is its own cyclus.
          // For other cycle types keep one row per trainer (cycle name is meaningful).
          const seriesMap = new Map<string, any[]>();
          cyclusSlots.forEach((slot: any) => {
            const tid = slot.trainer_id || '';
            let key: string;
            if (isRegistration) {
              try {
                const sd = parseISO(slot.start_time);
                const ed = parseISO(slot.end_time);
                key = `${tid}::${sd.getDay()}::${format(sd, 'HH:mm')}-${format(ed, 'HH:mm')}`;
              } catch {
                key = `${tid}::?`;
              }
            } else {
              key = tid;
            }
            if (!seriesMap.has(key)) seriesMap.set(key, []);
            seriesMap.get(key)!.push(slot);
          });

          seriesMap.forEach((seriesSlots, seriesKey) => {
            const trainerId = seriesSlots[0].trainer_id || '';
            const trainerName = trainerNameMap[trainerId] || 'Unknown';
            const sorted = [...seriesSlots].sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
            const first = sorted[0];
            const last = sorted[sorted.length - 1];

            const locationName = (first.locations as any)?.name || (cycle.locations as any)?.name || null;

            let dayTime = '—';
            let dayName = '';
            let startHHMM = '';
            try {
              const startDate = parseISO(first.start_time);
              const endDate = parseISO(first.end_time);
              dayName = format(startDate, 'EEEE', { locale: dateLocale });
              startHHMM = format(startDate, 'HH:mm');
              dayTime = `${dayName} ${startHHMM} - ${format(endDate, 'HH:mm')}`;
            } catch { /* ignore */ }

            const periodStart = first.start_time || cycle.start_date || new Date().toISOString();
            const periodEnd = last.start_time || cycle.end_date || new Date().toISOString();

            const allPlayerNames = new Set<string>();
            let maxBooked = 0;
            seriesSlots.forEach((s: any) => {
              const names = playerNamesMap[s.id] || [];
              names.forEach((n: string) => allPlayerNames.add(n));
              const count = bookingCountMap[s.id] || 0;
              if (count > maxBooked) maxBooked = count;
            });
            if (!isRegistration) {
              const intakePlayers = intakePlayerMap[cycleId] || [];
              intakePlayers.forEach(n => allPlayerNames.add(n));
            }

            const pricePerSession = cycle.price_per_session ?? first.price_per_session ?? null;

            // Per-series label for registration cycles, e.g. "Maandag 18:00 - Floris"
            let cyclusName = cycle.name || cycleId;
            if (isRegistration) {
              const firstPlayer = Array.from(allPlayerNames)[0];
              cyclusName = firstPlayer
                ? `${dayName} ${startHHMM} - ${firstPlayer}`
                : `${dayName} ${startHHMM}`;
            }

            grouped.push({
              group_key: `${cycleId}::${seriesKey}`,
              cyclus_id: cycleId,
              cyclus_name: cyclusName,
              trainer_name: trainerName,
              trainer_id: trainerId,
              location_name: locationName,
              day_time: dayTime,
              period_start: periodStart,
              period_end: periodEnd,
              sessions: seriesSlots.length,
              player_names: Array.from(allPlayerNames).sort(),
              player_count: allPlayerNames.size,
              price_per_session: pricePerSession,
              max_participants: first.max_participants || 4,
              max_booked: maxBooked,
              first_slot_id: first.id,
              is_public: seriesSlots.some((s: { is_public?: boolean }) => s.is_public),
              status: cycle.status || 'draft',
              type: isRegistration ? 'cyclus' : (cycle.type || 'cyclus'),
              has_slots: true,
              payment_status_summary: paymentSummaryForSlots(seriesSlots.map((s: { id: string }) => s.id)),
            });
          });
        }
      });

      // Process orphan slot groups (cyclus_id not in cycles table)
      slotsByCyclus.forEach((cyclusSlots, cyclusId) => {
        if (processedCyclusIds.has(cyclusId)) return;

        const slotsByTrainer = new Map<string, any[]>();
        cyclusSlots.forEach((slot: any) => {
          const tid = slot.trainer_id || '';
          if (!slotsByTrainer.has(tid)) slotsByTrainer.set(tid, []);
          slotsByTrainer.get(tid)!.push(slot);
        });

        slotsByTrainer.forEach((trainerSlots, trainerId) => {
          const first = trainerSlots[0];
          const last = trainerSlots[trainerSlots.length - 1];

          let dayTime = '—';
          try {
            const startDate = parseISO(first.start_time);
            const endDate = parseISO(first.end_time);
            const dayName = format(startDate, 'EEEE', { locale: dateLocale });
            dayTime = `${dayName} ${format(startDate, 'HH:mm')} - ${format(endDate, 'HH:mm')}`;
          } catch { /* ignore */ }

          const allPlayerNames = new Set<string>();
          let maxBooked = 0;
          trainerSlots.forEach((s: any) => {
            const names = playerNamesMap[s.id] || [];
            names.forEach((n: string) => allPlayerNames.add(n));
            const count = bookingCountMap[s.id] || 0;
            if (count > maxBooked) maxBooked = count;
          });

          grouped.push({
            group_key: `${cyclusId}::${trainerId}`,
            cyclus_id: cyclusId,
            cyclus_name: first.cyclus_name || cyclusId,
            trainer_name: trainerNameMap[trainerId] || 'Unknown',
            trainer_id: trainerId,
            location_name: (first.locations as any)?.name || null,
            day_time: dayTime,
            period_start: first.start_time,
            period_end: last.start_time,
            sessions: trainerSlots.length,
            player_names: Array.from(allPlayerNames).sort(),
            player_count: allPlayerNames.size,
            price_per_session: first.price_per_session,
            max_participants: first.max_participants || 4,
            max_booked: maxBooked,
            first_slot_id: first.id,
            is_public: trainerSlots.some((s: { is_public?: boolean }) => s.is_public),
            status: 'active',
            type: 'cyclus',
            has_slots: true,
            payment_status_summary: paymentSummaryForSlots(trainerSlots.map((s: { id: string }) => s.id)),
          });
        });
      });

      setGroups(grouped);
    } catch (error) {
      logger.error('Error fetching cyclus overview', error as Error, { component: 'AcademyCyclusOverview' });
    } finally {
      setLoading(false);
    }
  };

  // Time-based filtering
  const timeFiltered = useMemo(() => {
    const now = new Date();
    return groups.filter(g => {
      if (!g.period_start || !g.period_end) return timeFilter === 'all';
      try {
        const start = parseISO(g.period_start);
        const end = parseISO(g.period_end);
        switch (timeFilter) {
          case 'current': return start <= now && end >= now;
          case 'future': return start > now;
          case 'past': return end < now;
          case 'all': return true;
          default: return true;
        }
      } catch {
        return timeFilter === 'all';
      }
    });
  }, [groups, timeFilter]);

  // Apply filters
  const filtered = useMemo(() => {
    return timeFiltered.filter(g => {
      if (filterTrainer !== 'all' && g.trainer_id !== filterTrainer) return false;
      if (filterLocation !== 'all' && g.location_name !== filterLocation) return false;
      if (filterVisibility === 'public' && !g.is_public) return false;
      if (filterVisibility === 'private' && g.is_public) return false;
      if (!matchesPaidFilter(g.payment_status_summary, filterPaid)) return false;
      if (search) {
        const q = search.toLowerCase();
        const match = g.cyclus_name.toLowerCase().includes(q)
          || g.trainer_name.toLowerCase().includes(q)
          || g.player_names.some(n => n.toLowerCase().includes(q))
          || (g.location_name || '').toLowerCase().includes(q);
        if (!match) return false;
      }
      return true;
    });
  }, [timeFiltered, filterTrainer, filterLocation, filterVisibility, filterPaid, search]);

  const { sortedData, sortConfig, handleSort } = useTableSort(filtered);

  // Deep link: focus matching bulk/recurring group (orphan cyclus_id)
  useEffect(() => {
    if (!highlightCyclusId || groups.length === 0) return;
    const match = groups.find((g) => g.cyclus_id === highlightCyclusId);
    if (!match) return;
    setSearch(match.cyclus_name);
    setTimeFilter("all");
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-cyclus-id="${highlightCyclusId}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }, [highlightCyclusId, groups]);

  // Bulk selection helpers
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === sortedData.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(sortedData.map(g => g.group_key)));
    }
  };

  const getSelectedSlotIds = async (): Promise<string[]> => {
    const groupKeys = Array.from(selectedIds);
    if (groupKeys.length === 0) return [];
    
    // Parse group_keys into (cyclus_id, trainer_id) pairs
    const pairs = groupKeys.map(key => {
      const [cyclusId, trainerId] = key.split('::');
      return { cyclusId, trainerId };
    });

    const allSlotIds: string[] = [];
    for (const { cyclusId, trainerId } of pairs) {
      let query = supabase
        .from('availability_slots')
        .select('id')
        .eq('cyclus_id', cyclusId);
      if (trainerId) {
        query = query.eq('trainer_id', trainerId);
      }
      const { data } = await query;
      (data || []).forEach(s => allSlotIds.push(s.id));
    }
    return allSlotIds;
  };

  const handleBulkVisibility = async (makePublic: boolean) => {
    setBulkUpdating(true);
    try {
      const slotIds = await getSelectedSlotIds();
      if (slotIds.length === 0) {
        toast({ title: t('cyclesTab.noSlotsFound') });
        return;
      }
      for (let i = 0; i < slotIds.length; i += 500) {
        const chunk = slotIds.slice(i, i + 500);
        await supabase
          .from('availability_slots')
          .update({ is_public: makePublic })
          .in('id', chunk);
      }
      toast({ title: t('cyclesTab.visibilityUpdated', { count: slotIds.length, state: makePublic ? t('cyclesTab.visible') : t('cyclesTab.hidden') }) });
      setSelectedIds(new Set());
      fetchCyclusData();
    } catch (error) {
      logger.error('Bulk visibility update failed', error as Error);
      toast({ title: t('cyclesTab.error'), variant: 'destructive' });
    } finally {
      setBulkUpdating(false);
    }
  };

  // Bulk-delete the selected cycli. SKIPS any cyclus that has bookings (a player booking is
  // never silently cancelled) — those are reported back. Each cyclus is independent: one
  // failure never aborts the rest.
  const handleBulkDelete = async () => {
    const groups = sortedData.filter(g => selectedIds.has(g.group_key) && g.cyclus_id);
    setBulkUpdating(true);
    let deleted = 0;
    let skipped = 0;
    const failed: string[] = [];
    try {
      for (const g of groups) {
        try {
          if (g.max_booked > 0) { skipped++; continue; }
          const [cyclusId, trainerId] = g.group_key.split('::');
          let sq = supabase.from('availability_slots').select('id').eq('cyclus_id', cyclusId);
          if (trainerId) sq = sq.eq('trainer_id', trainerId);
          const { data: slotRows } = await sq;
          const slotIds = (slotRows || []).map((s: { id: string }) => s.id);
          if (slotIds.length > 0) {
            // Re-verify no booking appeared since the list loaded (never cascade a booking).
            const { data: booked } = await supabase.from('bookings').select('slot_id')
              .in('slot_id', slotIds).in('status', ['confirmed', 'booked', 'pending']);
            if ((booked || []).length > 0) { skipped++; continue; }
            const { error } = await supabase.from('availability_slots').delete().in('id', slotIds);
            if (error) throw error;
          }
          deleted++;
        } catch (e) {
          logger.error('Bulk cyclus delete failed', e as Error, { group: g.group_key });
          failed.push(g.cyclus_name);
        }
      }
      if (failed.length > 0) {
        toast({ title: t('cyclesTab.bulkDelete.partial', { deleted, skipped, failed: failed.length }), description: failed.join(', '), variant: 'destructive' });
      } else if (skipped > 0) {
        toast({ title: t('cyclesTab.bulkDelete.doneSkipped', { deleted, skipped }) });
      } else {
        toast({ title: t('cyclesTab.bulkDelete.done', { count: deleted }) });
      }
      setSelectedIds(new Set());
      setDeleteDialogOpen(false);
      fetchCyclusData();
    } finally {
      setBulkUpdating(false);
    }
  };

  const handleBulkPriceUpdate = async () => {
    const price = parseFloat(bulkPrice);
    if (isNaN(price) || price < 0) {
      toast({ title: t('cyclesTab.invalidPrice'), variant: 'destructive' });
      return;
    }
    setBulkUpdating(true);
    try {
      const slotIds = await getSelectedSlotIds();
      if (slotIds.length === 0) {
        toast({ title: t('cyclesTab.noSlotsFound') });
        return;
      }
      for (let i = 0; i < slotIds.length; i += 500) {
        const chunk = slotIds.slice(i, i + 500);
        await supabase
          .from('availability_slots')
          .update({ price_per_session: price })
          .in('id', chunk);
      }
      // Sync invoices
      await syncInvoicesAfterPriceChange(slotIds);
      toast({ title: t('cyclesTab.priceUpdated', { count: slotIds.length }) });
      setPriceDialogOpen(false);
      setBulkPrice('');
      setSelectedIds(new Set());
      fetchCyclusData();
    } catch (error) {
      logger.error('Bulk price update failed', error as Error);
      toast({ title: t('cyclesTab.error'), variant: 'destructive' });
    } finally {
      setBulkUpdating(false);
    }
  };

  const handleRowClick = (group: CyclusGroup) => {
    if (group.first_slot_id) {
      navigate(`/app/academy/slot/${group.first_slot_id}`);
    } else {
      navigate(`/app/academy/registrations?cycle=${group.cyclus_id}`);
    }
  };

  const getStatusBadge = (group: CyclusGroup) => {
    if (!group.has_slots && group.sessions === 0) {
      return <Badge variant="outline" className="text-xs">{t('cyclesTab.noSessions')}</Badge>;
    }
    return (
      <Badge variant={group.max_booked >= group.max_participants ? 'destructive' : 'secondary'}>
        {group.max_booked}/{group.max_participants}
      </Badge>
    );
  };

  const getPaymentBadge = (group: CyclusGroup) => {
    const key =
      group.payment_status_summary === 'all_paid'
        ? 'cyclesTab.paymentAllPaid'
        : group.payment_status_summary === 'has_unpaid'
          ? 'cyclesTab.paymentOpen'
          : 'cyclesTab.paymentNoPlayers';
    return (
      <Badge variant={paymentStatusBadgeVariant(group.payment_status_summary)} className="text-xs whitespace-nowrap">
        {t(key)}
      </Badge>
    );
  };

  const getTypeBadge = (type: string) => {
    switch (type) {
      case 'registration': return <Badge variant="outline" className="text-xs">{t('cyclesTab.registration')}</Badge>;
      case 'event': return <Badge variant="outline" className="text-xs">{t('cyclesTab.event')}</Badge>;
      default: return null;
    }
  };

  if (loading) {
    return <Skeleton className="h-[400px] w-full" />;
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row gap-3 flex-wrap">
            <div className="relative w-full sm:w-[260px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t('calendar.searchPlaceholder', 'Search cycles, trainers, players...')}
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-9 h-9"
              />
            </div>

            <Select value={timeFilter} onValueChange={v => setTimeFilter(v as TimeFilter)}>
              <SelectTrigger className="w-full sm:w-[140px] h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="current">{t('cyclesTab.current')}</SelectItem>
                <SelectItem value="future">{t('cyclesTab.future')}</SelectItem>
                <SelectItem value="past">{t('cyclesTab.past')}</SelectItem>
                <SelectItem value="all">{t('cyclesTab.all')}</SelectItem>
              </SelectContent>
            </Select>

            {trainers.length > 1 && (
              <Select value={filterTrainer} onValueChange={setFilterTrainer}>
                <SelectTrigger className="w-full sm:w-[160px] h-9">
                  <SelectValue placeholder={t('calendar.allTrainers', 'All Trainers')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('calendar.allTrainers', 'All Trainers')}</SelectItem>
                  {trainers.map(tr => (
                    <SelectItem key={tr.id} value={tr.id}>{tr.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {locations.length > 1 && (
              <Select value={filterLocation} onValueChange={setFilterLocation}>
                <SelectTrigger className="w-full sm:w-[160px] h-9">
                  <SelectValue placeholder={t('calendar.allLocations', 'All Locations')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('calendar.allLocations', 'All Locations')}</SelectItem>
                  {locations.map(loc => (
                    <SelectItem key={loc} value={loc}>{loc}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <Select value={filterPaid} onValueChange={v => setFilterPaid(v as PaidFilterValue)}>
              <SelectTrigger className="w-full sm:w-[180px] h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('cyclesTab.paidFilterAll')}</SelectItem>
                <SelectItem value="paid">{t('cyclesTab.paidFilterPaid')}</SelectItem>
                <SelectItem value="unpaid">{t('cyclesTab.paidFilterUnpaid')}</SelectItem>
                <SelectItem value="no_players">{t('cyclesTab.paidFilterNoPlayers')}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filterVisibility} onValueChange={v => setFilterVisibility(v as 'all' | 'public' | 'private')}>
              <SelectTrigger className="w-full sm:w-[180px] h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('cyclesTab.visibilityFilterAll', { defaultValue: 'All visibility' })}</SelectItem>
                <SelectItem value="public">{t('cyclesTab.visibilityFilterPublic', { defaultValue: 'Public (on profile)' })}</SelectItem>
                <SelectItem value="private">{t('cyclesTab.visibilityFilterPrivate', { defaultValue: 'Private' })}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Summary + Bulk Actions */}
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {sortedData.length} {sortedData.length === 1 ? t('cyclesTab.cycle') : t('cyclesTab.cycles')}
          {selectedIds.size > 0 && ` · ${selectedIds.size} ${t('cyclesTab.selected')}`}
        </div>
        {selectedIds.size > 0 && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={bulkUpdating}
              onClick={() => handleBulkVisibility(true)}
            >
              <Eye className="h-3.5 w-3.5 mr-1.5" />
              {t('cyclesTab.makeVisible')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={bulkUpdating}
              onClick={() => handleBulkVisibility(false)}
            >
              <EyeOff className="h-3.5 w-3.5 mr-1.5" />
              {t('cyclesTab.hide')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={bulkUpdating}
              onClick={() => { setBulkPrice(''); setPriceDialogOpen(true); }}
            >
              <Euro className="h-3.5 w-3.5 mr-1.5" />
              {t('cyclesTab.changePrice')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={bulkUpdating}
              onClick={() => setDeleteDialogOpen(true)}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1.5" />
              {t('cyclesTab.bulkDelete.button', { defaultValue: 'Delete' })}
            </Button>
          </div>
        )}
      </div>

      {/* Desktop Table */}
      <Card className="hidden md:block">
        <div className="overflow-x-auto">
          <Table className="[&_td]:py-1.5 [&_td]:px-3 [&_th]:py-1 [&_th]:px-3 [&_th]:h-9 text-sm">
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow>
                <TableHead className="w-[40px] whitespace-nowrap">
                  <Checkbox
                    checked={sortedData.length > 0 && selectedIds.size === sortedData.length}
                    onCheckedChange={toggleSelectAll}
                  />
                </TableHead>
                <SortableTableHead sortKey="cyclus_name" currentSortKey={sortConfig.key as string} currentDirection={sortConfig.direction} onSort={handleSort as (key: string) => void} className="whitespace-nowrap">{t('cyclesTab.name')}</SortableTableHead>
                <SortableTableHead sortKey="trainer_name" currentSortKey={sortConfig.key as string} currentDirection={sortConfig.direction} onSort={handleSort as (key: string) => void} className="whitespace-nowrap">{t('cyclesTab.trainer')}</SortableTableHead>
                <TableHead className="whitespace-nowrap">{t('cyclesTab.location')}</TableHead>
                <TableHead className="whitespace-nowrap">{t('cyclesTab.dayTime')}</TableHead>
                <SortableTableHead sortKey="period_start" currentSortKey={sortConfig.key as string} currentDirection={sortConfig.direction} onSort={handleSort as (key: string) => void} className="whitespace-nowrap">{t('cyclesTab.period')}</SortableTableHead>
                <SortableTableHead sortKey="sessions" currentSortKey={sortConfig.key as string} currentDirection={sortConfig.direction} onSort={handleSort as (key: string) => void} className="whitespace-nowrap">{t('cyclesTab.sessions')}</SortableTableHead>
                <SortableTableHead sortKey="player_count" currentSortKey={sortConfig.key as string} currentDirection={sortConfig.direction} onSort={handleSort as (key: string) => void} className="whitespace-nowrap">{t('cyclesTab.players')}</SortableTableHead>
                <SortableTableHead sortKey="payment_status_summary" currentSortKey={sortConfig.key as string} currentDirection={sortConfig.direction} onSort={handleSort as (key: string) => void} className="whitespace-nowrap">{t('cyclesTab.paymentStatus')}</SortableTableHead>
                <TableHead className="whitespace-nowrap">{t('cyclesTab.price')}</TableHead>
                <TableHead className="whitespace-nowrap">{t('cyclesTab.occupancy')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedData.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={11} className="text-center text-muted-foreground py-12">
                    {t('cyclesTab.noCyclesFound')}
                  </TableCell>
                </TableRow>
              ) : (
                sortedData.map((group) => (
                  <TableRow
                    key={group.group_key}
                    data-cyclus-id={group.cyclus_id}
                    className={cn(
                      "h-8 cursor-pointer hover:bg-muted/50",
                      highlightCyclusId === group.cyclus_id && "bg-primary/10 ring-1 ring-primary/30",
                    )}
                    onClick={() => handleRowClick(group)}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox checked={selectedIds.has(group.group_key)} onCheckedChange={() => toggleSelect(group.group_key)} />
                    </TableCell>
                    <TableCell className="font-medium max-w-[200px]" title={group.cyclus_name}>
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="truncate">{group.cyclus_name}</span>
                        {getTypeBadge(group.type)}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap max-w-[160px] truncate" title={group.trainer_name}>{group.trainer_name}</TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap max-w-[180px] truncate" title={group.location_name || ''}>{group.location_name || '—'}</TableCell>
                    <TableCell className="text-sm whitespace-nowrap">{group.day_time}</TableCell>
                    <TableCell className="text-sm whitespace-nowrap">
                      {format(parseISO(group.period_start), 'd MMM', { locale: dateLocale })}
                      {' → '}
                      {format(parseISO(group.period_end), 'd MMM yyyy', { locale: dateLocale })}
                    </TableCell>
                    <TableCell className="text-center whitespace-nowrap">{group.sessions > 0 ? group.sessions : '—'}</TableCell>
                    <TableCell className="max-w-[240px]">
                      {group.player_count > 0 ? (
                        <div className="flex items-center gap-1.5 min-w-0" title={group.player_names.join(', ')}>
                          <Users className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <span className="text-sm truncate">{group.player_names.join(', ')}</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{getPaymentBadge(group)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {group.price_per_session != null ? formatPrice(group.price_per_session) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{getStatusBadge(group)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      {/* Mobile Cards */}
      <div className="md:hidden space-y-3">
        {sortedData.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              {t('cyclesTab.noCyclesFound')}
            </CardContent>
          </Card>
        ) : (
          sortedData.map((group) => (
            <Card
              key={group.group_key}
              data-cyclus-id={group.cyclus_id}
              className={cn(
                "cursor-pointer hover:bg-muted/50",
                highlightCyclusId === group.cyclus_id && "ring-2 ring-primary/40 bg-primary/5",
              )}
              onClick={() => handleRowClick(group)}
            >
              <CardContent className="p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{group.cyclus_name}</p>
                    <p className="text-xs text-muted-foreground">{group.trainer_name}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                    {getPaymentBadge(group)}
                    {getStatusBadge(group)}
                    {getTypeBadge(group.type)}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {group.location_name && <span>{group.location_name}</span>}
                  <span>{group.day_time}</span>
                  <span>
                    {format(parseISO(group.period_start), 'd MMM', { locale: dateLocale })}
                    {' → '}
                    {format(parseISO(group.period_end), 'd MMM', { locale: dateLocale })}
                  </span>
                  <span>{group.sessions} {t('cyclesTab.sessions')}</span>
                </div>
                {group.player_count > 0 && (
                  <div className="flex items-center gap-1.5 text-xs">
                    <Users className="h-3 w-3 text-muted-foreground" />
                    <span className="truncate">{group.player_names.slice(0, 2).join(', ')}</span>
                    {group.player_names.length > 2 && (
                      <Badge variant="secondary" className="text-xs">+{group.player_names.length - 2}</Badge>
                    )}
                  </div>
                )}
                {group.price_per_session != null && (
                  <p className="text-xs font-medium">{formatPrice(group.price_per_session)} / {t('cyclesTab.session', 'session')}</p>
                )}
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* Bulk Price Dialog */}
      <Dialog open={priceDialogOpen} onOpenChange={setPriceDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('cyclesTab.changePriceTitle', { count: selectedIds.size })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{t('cyclesTab.pricePerSession')}</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={bulkPrice}
                onChange={e => setBulkPrice(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <p className="text-sm text-muted-foreground">
              {t('cyclesTab.priceChangeDescription')}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPriceDialogOpen(false)}>
              {t('cyclesTab.cancel')}
            </Button>
            <Button onClick={handleBulkPriceUpdate} disabled={bulkUpdating}>
              {bulkUpdating ? t('cyclesTab.saving') : t('cyclesTab.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('cyclesTab.bulkDelete.confirmTitle', { count: selectedIds.size, defaultValue: 'Delete {{count}} cycli?' })}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            {t('cyclesTab.bulkDelete.confirmBody', { defaultValue: 'This permanently deletes the selected cycli and their open slots. Any cyclus that still has player bookings is skipped (never auto-cancelled) and reported back. This cannot be undone.' })}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)} disabled={bulkUpdating}>
              {t('cyclesTab.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleBulkDelete} disabled={bulkUpdating}>
              {bulkUpdating ? t('cyclesTab.saving') : t('cyclesTab.bulkDelete.button', { defaultValue: 'Delete' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
