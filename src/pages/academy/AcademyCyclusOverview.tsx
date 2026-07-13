import { useState, useEffect, useMemo, type ReactNode } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { format, parseISO, getDay, addDays, startOfWeek } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { Search, Users, Eye, EyeOff, Euro, Trash2, CalendarClock, Ticket, Layers, User, RectangleHorizontal, Ban } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { setSlotVisibility } from '@/lib/slots';
import { CAPACITY_OCCUPYING_STATUSES } from '@/lib/lessons';
import { personDisplayName, personKeyOf } from '@/lib/personIdentity';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SelectFilter } from '@/components/ui/select-filter';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { EditCycleEndDateDialog } from '@/components/cycles/EditCycleEndDateDialog';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { logger } from '@/lib/logger';
import { reportDeployDriftFallback } from '@/lib/deployDrift';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { useTableSort } from '@/hooks/useTableSort';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import { formatPrice } from '@/lib/pricing';
import { cn } from '@/lib/utils';
import { cancelBookingsAndDeleteSlots } from '@/lib/slotDeleteGuard';
import { setCycleBookingMode, setTargetedCyclePrice, deriveCycleBookingMode, type CycleBookingMode, type CycleBookingModeOrNone } from '@/lib/cycleBookingMode';
import { BulkBookingModeDialog } from '@/components/cycles/BulkBookingModeDialog';
import { deleteCycle } from '@/lib/cycleWrites';
import {
  computeCyclusGroupPaymentStatus,
  matchesPaidFilter,
  paymentStatusBadgeVariant,
  type CyclusGroupPaymentStatus,
  type PaidFilterValue,
} from '@/lib/cyclusGroupPayment';
import {
  mapCyclusGroupRow,
  isMissingCyclusGroupsRpc,
  type CyclusGroup,
  type AcademyCyclusGroupRow,
} from '@/lib/academyCyclusGroups';

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
  // Opt-in (default off): also delete selected cycli that still have bookings, cancelling those
  // bookings first. Off = the safe legacy behaviour (booked cycli are skipped, never auto-cancelled).
  const [forceDeleteBooked, setForceDeleteBooked] = useState(false);
  const [editEndDateGroup, setEditEndDateGroup] = useState<CyclusGroup | null>(null);
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('current');
  const [filterDay, setFilterDay] = useState('all'); // 'all' | '0'(Mon) … '6'(Sun)
  // Boekbaarheid per group_key, resolved from a supplemental first-slot + settings
  // fetch after the groups load (neither group builder carries the flags).
  const [bookingModeByGroup, setBookingModeByGroup] = useState<Record<string, CycleBookingModeOrNone>>({});

  // Persist the active filters so opening a cycle and clicking back keeps them (this page unmounts on
  // navigation, resetting useState). Keyed by academy so a stale trainer/location can't leak across
  // academies; sessionStorage so it resets on a new browser session. Persisting starts only AFTER the
  // one-time restore, so the restore can't be clobbered by a default-value write.
  const filterStorageKey = activeAcademy ? `academyCyclusFilters:${activeAcademy.id}` : null;
  const [filtersRestored, setFiltersRestored] = useState(false);
  useEffect(() => {
    if (!filterStorageKey || filtersRestored) return;
    try {
      const raw = sessionStorage.getItem(filterStorageKey);
      if (raw) {
        const s = JSON.parse(raw);
        if (typeof s.search === 'string') setSearch(s.search);
        if (typeof s.filterTrainer === 'string') setFilterTrainer(s.filterTrainer);
        if (typeof s.filterLocation === 'string') setFilterLocation(s.filterLocation);
        if (['all', 'paid', 'unpaid', 'no_players'].includes(s.filterPaid)) setFilterPaid(s.filterPaid);
        if (['all', 'public', 'private'].includes(s.filterVisibility)) setFilterVisibility(s.filterVisibility);
        if (['current', 'future', 'past', 'all'].includes(s.timeFilter)) setTimeFilter(s.timeFilter);
        if (typeof s.filterDay === 'string' && ['all', '0', '1', '2', '3', '4', '5', '6'].includes(s.filterDay)) setFilterDay(s.filterDay);
      }
    } catch { /* ignore malformed stored filters */ }
    setFiltersRestored(true);
  }, [filterStorageKey, filtersRestored]);
  useEffect(() => {
    if (!filterStorageKey || !filtersRestored) return;
    try {
      sessionStorage.setItem(
        filterStorageKey,
        JSON.stringify({ search, filterTrainer, filterLocation, filterPaid, filterVisibility, timeFilter, filterDay }),
      );
    } catch { /* ignore quota/serialization errors */ }
  }, [filterStorageKey, filtersRestored, search, filterTrainer, filterLocation, filterPaid, filterVisibility, timeFilter, filterDay]);

  // Bulk actions
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [priceDialogOpen, setPriceDialogOpen] = useState(false);
  const [bulkPrice, setBulkPrice] = useState('');
  const [bookingModeDialogOpen, setBookingModeDialogOpen] = useState(false);

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
      const viaRpc = await fetchGroupsViaRpc(activeAcademy.id);
      const built = viaRpc ?? (await buildGroupsClientSide());
      const visible = await hideSplitParentShells(built, activeAcademy.id);
      setGroups(visible);
      void loadBookingModes(visible);
    } catch (error) {
      logger.error('Error fetching cyclus overview', error as Error, { component: 'AcademyCyclusOverview' });
    } finally {
      setLoading(false);
    }
  };

  // Resolve each group's Boekbaarheid for the icon column: the authoritative flags live
  // on the SLOTS (allow_single_booking / whole_slot_booking — representative first slot,
  // same readout the guest dialog uses) and on cycles.settings.allow_cyclus_booking
  // (absent = true). Registration series and events are not sold via booking modes → no entry.
  // Non-fatal: on any error the column shows "—" rather than blocking the list.
  const loadBookingModes = async (gs: CyclusGroup[]) => {
    try {
      const eligible = gs.filter((g) => g.type === 'cyclus' && !g.is_registration && g.has_slots && g.first_slot_id);
      if (eligible.length === 0) {
        setBookingModeByGroup({});
        return;
      }
      const slotIds = [...new Set(eligible.map((g) => g.first_slot_id as string))];
      const cycleIds = [...new Set(eligible.filter((g) => g.has_cycle_row).map((g) => g.cyclus_id))];
      const [slotRes, cycleRes] = await Promise.all([
        supabase.from('availability_slots').select('id, allow_single_booking, whole_slot_booking' as never).in('id', slotIds),
        cycleIds.length > 0
          ? supabase.from('cycles').select('id, settings').in('id', cycleIds)
          : Promise.resolve({ data: [] as { id: string; settings: unknown }[] }),
      ]);
      const flagsBySlot = new Map(
        ((slotRes.data ?? []) as unknown as { id: string; allow_single_booking: boolean | null; whole_slot_booking: boolean | null }[])
          .map((r) => [r.id, r]),
      );
      const cyclusAllowedByCycle = new Map(
        ((cycleRes.data ?? []) as { id: string; settings: unknown }[]).map((c) => [
          c.id,
          (c.settings as { allow_cyclus_booking?: boolean } | null)?.allow_cyclus_booking !== false,
        ]),
      );
      const next: Record<string, CycleBookingModeOrNone> = {};
      for (const g of eligible) {
        const f = flagsBySlot.get(g.first_slot_id as string);
        if (!f) continue;
        next[g.group_key] = deriveCycleBookingMode({
          allowSingle: f.allow_single_booking === true,
          wholeSlot: f.whole_slot_booking === true,
          allowCyclus: g.has_cycle_row ? (cyclusAllowedByCycle.get(g.cyclus_id) ?? true) : true,
        });
      }
      setBookingModeByGroup(next);
    } catch (e) {
      logger.error('Failed to resolve booking modes for the list (non-fatal)', e as Error, { component: 'AcademyCyclusOverview' });
    }
  };

  // Hide the empty parent shells left behind by the one-time cycle-series split
  // (docs/CYCLE_SERIES_SPLIT.sql): their slots now live on the per-series child cycles, so the
  // 0-session parent row is just noise in the cycles list (the parents are retained in the DB
  // because they still back their registration form + intake_requests). FE-only, no DB change:
  // a split parent is any cycle referenced by a child's settings.split_from_cycle_id.
  const hideSplitParentShells = async (built: CyclusGroup[], academyId: string): Promise<CyclusGroup[]> => {
    try {
      const { data } = await supabase
        .from('cycles')
        .select('settings')
        .eq('owner_type', 'academy')
        .eq('owner_id', academyId)
        .eq('settings->>split_migration', 'CYCLE_SERIES_SPLIT_v1');
      const parentIds = new Set<string>();
      for (const r of (data ?? []) as unknown as Array<{ settings: Record<string, unknown> | null }>) {
        const pid = r.settings?.split_from_cycle_id;
        if (typeof pid === 'string') parentIds.add(pid);
      }
      if (parentIds.size === 0) return built;
      return built.filter((g) => !(g.cyclus_id && parentIds.has(g.cyclus_id)));
    } catch {
      return built; // best-effort cleanup — never block the overview on it
    }
  };

  // Server-side aggregation (Phase 3 P0): one RPC returns the already-grouped rows instead of
  // streaming the academy's entire slot/booking/intake set to the browser. Returns null when the
  // RPC is unavailable (not yet deployed → PGRST202/42883) or errors, so the caller falls back to
  // the proven client aggregation — zero behaviour change in the deploy gap. The CLIENT still does
  // the locale formatting (day_time + the per-series registration label) in mapCyclusGroupRow.
  const fetchGroupsViaRpc = async (academyId: string): Promise<CyclusGroup[] | null> => {
    const { data, error } = await supabase.rpc(
      'get_academy_cyclus_groups' as never,
      { p_academy_id: academyId } as never,
    );
    if (error) {
      if (isMissingCyclusGroupsRpc(error)) {
        reportDeployDriftFallback('get_academy_cyclus_groups', { academyId });
      } else {
        logger.error('get_academy_cyclus_groups failed — falling back to client aggregation', error as Error, { component: 'AcademyCyclusOverview' });
      }
      return null;
    }
    const rows = (data ?? []) as AcademyCyclusGroupRow[];
    // The RPC's period_end is the LAST slot's start; day_time needs the FIRST slot's END. Fetch it
    // for the handful of first_slot_ids (one per group) — cheap vs the whole-academy client scan.
    const firstSlotIds = [...new Set(rows.map((r) => r.first_slot_id).filter(Boolean))] as string[];
    const firstSlotEndById: Record<string, string> = {};
    if (firstSlotIds.length > 0) {
      const { data: slotEnds } = await supabase
        .from('availability_slots')
        .select('id, end_time')
        .in('id', firstSlotIds);
      (slotEnds ?? []).forEach((s: { id: string; end_time: string | null }) => {
        if (s.end_time) firstSlotEndById[s.id] = s.end_time;
      });
    }
    return rows.map((r) => mapCyclusGroupRow(r, firstSlotEndById, dateLocale));
  };

  // Legacy client-side aggregation — the graceful fallback when the RPC is unavailable.
  // Behaviour-frozen: the body below is unchanged; it just returns the groups instead of setting
  // state (and no longer owns the loading flag, which fetchCyclusData manages).
  const buildGroupsClientSide = async (): Promise<CyclusGroup[]> => {
    if (!activeAcademy) return [];
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

      // 3. Fetch booking data for player names and payment status. Entries are PERSON-keyed
      // (FAM-02 Level 1, personIdentity.ts) so two same-named distinct people stay distinct and
      // a dual-keyed (linked guest) seat shows the guest's OWN name — mirroring the RPC
      // (20260816100000). NOTE: this fallback's bookedCount stays hold-blind (the RPC is
      // hold-aware); it only runs in the deploy gap when the RPC is missing.
      const slotIds = allSlots.map(s => s.id);
      const playerNamesMap: Record<string, { key: string; name: string }[]> = {};
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
            const key = personKeyOf(b);
            const name = personDisplayName(b, {
              profileName: b.player_id ? playerNameLookup[b.player_id] : null,
              guestName: b.guest_player_id ? guestNameLookup[b.guest_player_id] : null,
            });
            if (key && name) {
              if (!playerNamesMap[b.slot_id]) playerNamesMap[b.slot_id] = [];
              playerNamesMap[b.slot_id].push({ key, name });
            }
          });
        }
      }

      // 4. Also fetch intake requests for cycles without slots (to show registered players).
      // Person-keyed like the bookings (dedup by person, not by name).
      const intakePlayerMap: Record<string, { key: string; name: string }[]> = {};
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
              const key = personKeyOf(ir);
              const name = personDisplayName(ir, {
                profileName: ir.player_id ? intakePlayerLookup[ir.player_id] : null,
                guestName: ir.guest_player_id ? intakeGuestLookup[ir.guest_player_id] : null,
              });
              if (key && name) {
                if (!intakePlayerMap[ir.cycle_id]) intakePlayerMap[ir.cycle_id] = [];
                if (!intakePlayerMap[ir.cycle_id].some((e) => e.key === key)) {
                  intakePlayerMap[ir.cycle_id].push({ key, name });
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
          const intakePlayers = (intakePlayerMap[cycleId] || []).map((e) => e.name);

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
            has_cycle_row: true,
            is_registration: false,
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

            // Distinct PERSONS (not names) across the series; intake persons merge in unless
            // their NAME already appears among the booked names (the historical intake↔booking
            // merge — an intake shares no person key with its later booking, only the name).
            const persons = new Map<string, string>();
            let maxBooked = 0;
            seriesSlots.forEach((s: any) => {
              (playerNamesMap[s.id] || []).forEach((e) => persons.set(e.key, e.name));
              const count = bookingCountMap[s.id] || 0;
              if (count > maxBooked) maxBooked = count;
            });
            if (!isRegistration) {
              const bookedNames = new Set(persons.values());
              (intakePlayerMap[cycleId] || []).forEach((e) => {
                if (!persons.has(e.key) && !bookedNames.has(e.name)) persons.set(e.key, e.name);
              });
            }
            // An ARRAY, not a Set — two distinct same-named persons must count as 2.
            const allPlayerNames = [...persons.values()];

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
              player_names: [...allPlayerNames].sort(),
              player_count: allPlayerNames.length,
              price_per_session: pricePerSession,
              max_participants: first.max_participants || 4,
              max_booked: maxBooked,
              first_slot_id: first.id,
              is_public: seriesSlots.some((s: { is_public?: boolean }) => s.is_public),
              status: cycle.status || 'draft',
              type: isRegistration ? 'cyclus' : (cycle.type || 'cyclus'),
              has_slots: true,
              has_cycle_row: true,
              is_registration: isRegistration,
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

          // Distinct persons (see the series aggregation above) — an array, not a name Set.
          const persons = new Map<string, string>();
          let maxBooked = 0;
          trainerSlots.forEach((s: any) => {
            (playerNamesMap[s.id] || []).forEach((e) => persons.set(e.key, e.name));
            const count = bookingCountMap[s.id] || 0;
            if (count > maxBooked) maxBooked = count;
          });
          const allPlayerNames = [...persons.values()];

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
            player_names: [...allPlayerNames].sort(),
            player_count: allPlayerNames.length,
            price_per_session: first.price_per_session,
            max_participants: first.max_participants || 4,
            max_booked: maxBooked,
            first_slot_id: first.id,
            is_public: trainerSlots.some((s: { is_public?: boolean }) => s.is_public),
            status: 'active',
            type: 'cyclus',
            has_slots: true,
            has_cycle_row: false,
            is_registration: false,
            payment_status_summary: paymentSummaryForSlots(trainerSlots.map((s: { id: string }) => s.id)),
          });
        });
      });

      return grouped;
    } catch (error) {
      logger.error('Error building cyclus overview (client fallback)', error as Error, { component: 'AcademyCyclusOverview' });
      return [];
    }
  };

  // Time-based filtering
  // Monday-first weekday options for the day filter, labeled in the viewer's locale.
  const weekdayOptions = useMemo(() => {
    const monday = startOfWeek(new Date(), { weekStartsOn: 1 });
    return Array.from({ length: 7 }, (_, i) => ({
      value: String(i),
      label: format(addDays(monday, i), 'EEEE', { locale: dateLocale }),
    }));
  }, [dateLocale]);

  // Split day_time into standalone, sortable/filterable parts. day_name/time_range
  // reuse the exact locale string the combined column showed (single source: day_time);
  // day_index is Monday-first (0..6) for the day filter; time_key sorts lexicographically.
  const enrichedGroups = useMemo(
    () =>
      groups.map((g) => {
        let day_name = '—';
        let time_range = '—';
        let time_key = '';
        let day_index = -1;
        if (g.has_slots && g.day_time !== '—') {
          const sp = g.day_time.indexOf(' ');
          day_name = sp > 0 ? g.day_time.slice(0, sp) : g.day_time;
          time_range = sp > 0 ? g.day_time.slice(sp + 1) : '—';
          try {
            const start = parseISO(g.period_start);
            day_index = (getDay(start) + 6) % 7; // 0 = Monday … 6 = Sunday
            time_key = format(start, 'HH:mm');
          } catch { /* keep defaults */ }
        }
        return { ...g, day_name, day_index, time_range, time_key, booking_mode: bookingModeByGroup[g.group_key] ?? null };
      }),
    [groups, bookingModeByGroup],
  );

  const timeFiltered = useMemo(() => {
    const now = new Date();
    return enrichedGroups.filter(g => {
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
  }, [enrichedGroups, timeFilter]);

  // Apply filters
  const filtered = useMemo(() => {
    return timeFiltered.filter(g => {
      if (filterTrainer !== 'all' && g.trainer_id !== filterTrainer) return false;
      if (filterDay !== 'all' && String(g.day_index) !== filterDay) return false;
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
  }, [timeFiltered, filterTrainer, filterDay, filterLocation, filterVisibility, filterPaid, search]);

  const { sortedData, sortConfig, handleSort } = useTableSort(filtered);

  // How many of the selected cycli still have bookings — drives the "also delete booked cycli" opt-in
  // (and its warning) in the delete dialog.
  const selectedBookedCount = sortedData.filter(
    (g) => selectedIds.has(g.group_key) && g.cyclus_id && g.max_booked > 0,
  ).length;

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
        await setSlotVisibility(chunk, makePublic);
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

  // Bulk-delete the selected cycli. By default SKIPS any cyclus that has bookings (a player booking is
  // never silently cancelled) and reports it back. When `forceDeleteBooked` is on, those bookings are
  // cancelled first so the cyclus can be fully deleted too. Each cyclus is independent: one failure
  // never aborts the rest. The cycle row itself is removed once all its sessions are gone, so a fully
  // deleted cyclus disappears from the list instead of lingering as an empty shell.
  const handleBulkDelete = async () => {
    const groups = sortedData.filter(g => selectedIds.has(g.group_key) && g.cyclus_id);
    setBulkUpdating(true);
    let deleted = 0;
    let skipped = 0;
    const failed: string[] = [];
    // Remove a cycle's row only once NO slot ANYWHERE still references it (cyclus-wide, so a
    // multi-trainer cyclus only loses its row when the last trainer's slots are gone) and never on a
    // count-query error (a null count must not strand sibling slots via ON DELETE SET NULL).
    const removeCycleRowIfEmpty = async (cyclusId: string) => {
      const { count, error: countErr } = await supabase
        .from('availability_slots')
        .select('id', { count: 'exact', head: true })
        .eq('cyclus_id', cyclusId);
      if (!countErr && count === 0) await deleteCycle(cyclusId);
    };
    try {
      for (const g of groups) {
        try {
          if (g.max_booked > 0 && !forceDeleteBooked) { skipped++; continue; }
          const [cyclusId, trainerId] = g.group_key.split('::');
          let sq = supabase.from('availability_slots').select('id').eq('cyclus_id', cyclusId);
          if (trainerId) sq = sq.eq('trainer_id', trainerId);
          const { data: slotRows } = await sq;
          const slotIds = (slotRows || []).map((s: { id: string }) => s.id);
          if (slotIds.length === 0) {
            // Empty shell (a cycle row with no sessions) — remove the row so it leaves the list, but
            // only when the cyclus is truly empty cyclus-wide (guards the multi-trainer TOCTOU).
            if (g.has_cycle_row) await removeCycleRowIfEmpty(cyclusId);
            deleted++;
            continue;
          }
          // Cancel any active bookings (force path), then atomically delete the now-empty slots via the
          // same canonical guarded RPC the slot-detail + cycle-detail use: it locks bookings FOR UPDATE
          // and KEEPS any slot that gained a booking since the list loaded — closing the
          // re-check-then-delete TOCTOU vs bookings.slot_id ON DELETE CASCADE. A real cycle
          // (has_cycle_row) drives the in-transaction split recalc + line-item rebuild internally.
          // Invoices reconcile (this list view has no per-page skip toggle).
          const res = await cancelBookingsAndDeleteSlots(g.has_cycle_row ? cyclusId : null, slotIds);
          if (res.deletedCount === 0 && res.protectedCount > 0) {
            // a booking raced in after the list loaded → the whole group is kept
            skipped++;
            continue;
          }
          // Remove the cycle row once every session for this cyclus is gone (only the group that
          // clears the last slot deletes the row).
          if (g.has_cycle_row) await removeCycleRowIfEmpty(cyclusId);
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
      setForceDeleteBooked(false);
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
      // Per-group so we can keep each backing cycle row's price in sync with its slots. The old path
      // wrote slot prices directly but left cycles.price_per_session stale → a cycle↔slot divergence
      // (the cycle display + future re-bookings drift from what's actually billed).
      const groups = sortedData.filter((g) => selectedIds.has(g.group_key) && g.cyclus_id);
      const slotIds: string[] = [];
      const realCycleIds = new Set<string>();
      for (const g of groups) {
        const [cyclusId, trainerId] = g.group_key.split('::');
        let sq = supabase.from('availability_slots').select('id').eq('cyclus_id', cyclusId);
        if (trainerId) sq = sq.eq('trainer_id', trainerId);
        const { data: slotRows } = await sq;
        (slotRows || []).forEach((s: { id: string }) => slotIds.push(s.id));
        if (g.has_cycle_row) realCycleIds.add(cyclusId);
      }
      if (slotIds.length === 0) {
        toast({ title: t('cyclesTab.noSlotsFound') });
        return;
      }
      // Facade bundles: slot price writes (billing source of truth) + per-cycle stored-price sync +
      // the unpaid-invoice rebuild — so the resync can never be forgotten (mutation-boundary P1-b).
      await setTargetedCyclePrice(slotIds, [...realCycleIds], price);
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

  // Bulk booking mode ("buy slot vs cycle"). CYCLE-WIDE by design: allow_cyclus_booking lives on the
  // cycle, so a per-group flip would leave one cycle half-switched (the guest dialog's documented
  // misconfiguration state). Registration series and events are excluded — a registration cycle spans
  // MANY series/groups, so a cycle-level write would leak far beyond the selected row.
  const handleBulkBookingMode = async (mode: CycleBookingMode) => {
    const groups = sortedData.filter((g) => selectedIds.has(g.group_key) && g.cyclus_id);
    const eligible = groups.filter((g) => g.type === 'cyclus' && !g.is_registration && g.has_slots);
    const skippedIneligible = groups.length - eligible.length;
    if (eligible.length === 0) {
      toast({ title: t('cyclesTab.bulkBooking.noneEligible'), variant: 'destructive' });
      return;
    }
    setBulkUpdating(true);
    try {
      const result = await setCycleBookingMode(
        eligible.map((g) => ({ cyclusId: g.cyclus_id, hasCycleRow: g.has_cycle_row, name: g.cyclus_name })),
        mode,
      );
      const skippedNotes: string[] = [];
      if (result.skippedBookedSlots > 0) {
        skippedNotes.push(t('cyclesTab.bulkBooking.skippedBooked', { count: result.skippedBookedSlots }));
      }
      if (result.skippedOrphans > 0 || skippedIneligible > 0) {
        skippedNotes.push(t('cyclesTab.bulkBooking.skippedCycles', { count: result.skippedOrphans + skippedIneligible }));
      }
      if (result.failed.length > 0) {
        toast({
          title: t('cyclesTab.bulkBooking.partial', { ok: result.succeeded, failed: result.failed.length }),
          description: `${result.failed.map((f) => f.name).join(', ')} — ${result.failed[0].reason}`,
          variant: 'destructive',
        });
      } else {
        toast({
          title: t('cyclesTab.bulkBooking.done', { count: result.succeeded }),
          description: skippedNotes.length > 0 ? skippedNotes.join(' · ') : undefined,
        });
      }
      setBookingModeDialogOpen(false);
      setSelectedIds(new Set());
      fetchCyclusData();
    } catch (error) {
      logger.error('Bulk booking-mode update failed', error as Error);
      toast({ title: t('cyclesTab.error'), variant: 'destructive' });
    } finally {
      setBulkUpdating(false);
    }
  };

  // The per-row destination: a real cycle → the cycle-detail centerpiece (the wrapper redirects a
  // registration/event type to /registrations/:id); an orphan cyclus_id group (slots only, no cycles
  // row) → its first session; otherwise the registrations list. Exposed as a URL so the name cell can
  // be a real <Link> (right/middle/Cmd-click → open in a new tab).
  const rowHref = (group: CyclusGroup) =>
    group.has_cycle_row
      ? `/app/academy/cycles/${group.cyclus_id}`
      : group.first_slot_id
        ? `/app/academy/slot/${group.first_slot_id}`
        : `/app/academy/registrations?cycle=${group.cyclus_id}`;

  // Whole-row click convenience for the dead area — gated so a modifier/middle click or a text-drag
  // falls through to the name <Link> (open-in-new-tab) instead of being hijacked by navigate().
  const handleRowClick = (group: CyclusGroup, e: React.MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (typeof window !== 'undefined' && window.getSelection()?.toString()) return;
    navigate(rowHref(group));
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

  // is_public = "any slot in this group is public" (shown/bookable on the profile page).
  // Groups without sessions have nothing to show publicly — render a dash, not "private".
  // Boekbaarheid icon (narrow column): one glyph per selling mode, full label in the
  // native tooltip. Registrations/events/no-data rows show a muted dash.
  const getBookingModeCell = (mode: CycleBookingModeOrNone | null) => {
    if (!mode) return <span className="text-muted-foreground">—</span>;
    const meta: Record<CycleBookingModeOrNone, { label: string; icons: ReactNode }> = {
      cyclus_only: { label: t('cyclesTab.bulkBooking.modeCyclusOnly'), icons: <Layers className="h-4 w-4" /> },
      both: {
        label: t('cyclesTab.bulkBooking.modeBoth'),
        icons: (
          <span className="flex items-center gap-0.5">
            <Layers className="h-4 w-4" />
            <User className="h-3.5 w-3.5" />
          </span>
        ),
      },
      single_only: { label: t('cyclesTab.bulkBooking.modeSingleOnly'), icons: <User className="h-4 w-4" /> },
      single_only_whole_slot: { label: t('cyclesTab.bulkBooking.modeSingleOnlyWholeSlot'), icons: <RectangleHorizontal className="h-4 w-4" /> },
      none: { label: t('cyclesTab.bookingModeNone', { defaultValue: 'Niet boekbaar (losse sessies én cyclus uit)' }), icons: <Ban className="h-4 w-4 text-destructive" /> },
    };
    const m = meta[mode];
    return (
      <span title={m.label} aria-label={m.label} className="inline-flex items-center text-muted-foreground">
        {m.icons}
        <span className="sr-only">{m.label}</span>
      </span>
    );
  };

  const getVisibilityBadge = (group: CyclusGroup) => {
    if (!group.has_slots) return <span className="text-muted-foreground">—</span>;
    return group.is_public ? (
      <Badge variant="outline" className="gap-1 text-xs font-normal">
        <Eye className="h-3 w-3" aria-hidden />
        {t('cyclesTab.visibilityPublic')}
      </Badge>
    ) : (
      <Badge variant="secondary" className="gap-1 text-xs font-normal text-muted-foreground">
        <EyeOff className="h-3 w-3" aria-hidden />
        {t('cyclesTab.visibilityPrivate')}
      </Badge>
    );
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

            {/* NOT SelectFilter: a time-scope chooser (default "current"), "all" is deliberately LAST. */}
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

            <SelectFilter
              value={filterDay}
              onValueChange={setFilterDay}
              allLabel={t('cyclesTab.dayFilterAll', { defaultValue: 'Alle dagen' })}
              options={weekdayOptions}
              triggerClassName="w-full sm:w-[140px] h-9"
            />

            {trainers.length > 1 && (
              <SelectFilter
                value={filterTrainer}
                onValueChange={setFilterTrainer}
                allLabel={t('calendar.allTrainers', 'All Trainers')}
                options={trainers.map(tr => ({ value: tr.id, label: tr.name }))}
                triggerClassName="w-full sm:w-[160px] h-9"
              />
            )}

            {locations.length > 1 && (
              <SelectFilter
                value={filterLocation}
                onValueChange={setFilterLocation}
                allLabel={t('calendar.allLocations', 'All Locations')}
                options={locations.map(loc => ({ value: loc, label: loc }))}
                triggerClassName="w-full sm:w-[160px] h-9"
              />
            )}

            <SelectFilter
              value={filterPaid}
              onValueChange={v => setFilterPaid(v as PaidFilterValue)}
              allLabel={t('cyclesTab.paidFilterAll')}
              options={[
                { value: 'paid', label: t('cyclesTab.paidFilterPaid') },
                { value: 'unpaid', label: t('cyclesTab.paidFilterUnpaid') },
                { value: 'no_players', label: t('cyclesTab.paidFilterNoPlayers') },
              ]}
              triggerClassName="w-full sm:w-[180px] h-9"
            />
            <SelectFilter
              value={filterVisibility}
              onValueChange={v => setFilterVisibility(v as 'all' | 'public' | 'private')}
              allLabel={t('cyclesTab.visibilityFilterAll', { defaultValue: 'All visibility' })}
              options={[
                { value: 'public', label: t('cyclesTab.visibilityFilterPublic', { defaultValue: 'Public (on profile)' }) },
                { value: 'private', label: t('cyclesTab.visibilityFilterPrivate', { defaultValue: 'Private' }) },
              ]}
              triggerClassName="w-full sm:w-[180px] h-9"
            />
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
              variant="outline"
              size="sm"
              disabled={bulkUpdating}
              onClick={() => setBookingModeDialogOpen(true)}
            >
              <Ticket className="h-3.5 w-3.5 mr-1.5" />
              {t('cyclesTab.bulkBooking.button')}
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
                <SortableTableHead sortKey="day_index" currentSortKey={sortConfig.key as string} currentDirection={sortConfig.direction} onSort={handleSort as (key: string) => void} className="whitespace-nowrap">{t('cyclesTab.day', { defaultValue: 'Dag' })}</SortableTableHead>
                <SortableTableHead sortKey="time_key" currentSortKey={sortConfig.key as string} currentDirection={sortConfig.direction} onSort={handleSort as (key: string) => void} className="whitespace-nowrap">{t('cyclesTab.time', { defaultValue: 'Tijd' })}</SortableTableHead>
                <SortableTableHead sortKey="period_start" currentSortKey={sortConfig.key as string} currentDirection={sortConfig.direction} onSort={handleSort as (key: string) => void} className="whitespace-nowrap">{t('cyclesTab.period')}</SortableTableHead>
                <SortableTableHead sortKey="sessions" currentSortKey={sortConfig.key as string} currentDirection={sortConfig.direction} onSort={handleSort as (key: string) => void} className="whitespace-nowrap">{t('cyclesTab.sessions')}</SortableTableHead>
                <SortableTableHead sortKey="player_count" currentSortKey={sortConfig.key as string} currentDirection={sortConfig.direction} onSort={handleSort as (key: string) => void} className="whitespace-nowrap">{t('cyclesTab.players')}</SortableTableHead>
                <SortableTableHead sortKey="payment_status_summary" currentSortKey={sortConfig.key as string} currentDirection={sortConfig.direction} onSort={handleSort as (key: string) => void} className="whitespace-nowrap">{t('cyclesTab.paymentStatus')}</SortableTableHead>
                <TableHead className="whitespace-nowrap">{t('cyclesTab.price')}</TableHead>
                <TableHead className="whitespace-nowrap">{t('cyclesTab.occupancy')}</TableHead>
                <SortableTableHead sortKey="is_public" currentSortKey={sortConfig.key as string} currentDirection={sortConfig.direction} onSort={handleSort as (key: string) => void} className="whitespace-nowrap">{t('cyclesTab.visibilityColumn')}</SortableTableHead>
                <SortableTableHead sortKey="booking_mode" currentSortKey={sortConfig.key as string} currentDirection={sortConfig.direction} onSort={handleSort as (key: string) => void} className="whitespace-nowrap w-[70px]">{t('cyclesTab.bulkBooking.button')}</SortableTableHead>
                <TableHead className="w-[44px]" aria-label={t('editEndDate.title', 'Einddatum aanpassen')} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedData.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={13} className="text-center text-muted-foreground py-12">
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
                    onClick={(e) => handleRowClick(group, e)}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox checked={selectedIds.has(group.group_key)} onCheckedChange={() => toggleSelect(group.group_key)} />
                    </TableCell>
                    <TableCell className="font-medium max-w-[200px]" title={group.cyclus_name}>
                      <div className="flex items-center gap-2 min-w-0">
                        <Link
                          to={rowHref(group)}
                          onClick={(e) => e.stopPropagation()}
                          className="truncate hover:underline rounded outline-none focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {group.cyclus_name}
                        </Link>
                        {getTypeBadge(group.type)}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap max-w-[160px] truncate" title={group.trainer_name}>{group.trainer_name}</TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap max-w-[180px] truncate" title={group.location_name || ''}>{group.location_name || '—'}</TableCell>
                    <TableCell className="text-sm whitespace-nowrap">{group.day_name}</TableCell>
                    <TableCell className="text-sm whitespace-nowrap">{group.time_range}</TableCell>
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
                    <TableCell className="whitespace-nowrap">{getVisibilityBadge(group)}</TableCell>
                    <TableCell className="whitespace-nowrap text-center">{getBookingModeCell(group.booking_mode)}</TableCell>
                    <TableCell className="w-[44px]" onClick={(e) => e.stopPropagation()}>
                      {group.cyclus_id && group.has_slots && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title={t('editEndDate.title', 'Einddatum aanpassen')}
                          onClick={() => setEditEndDateGroup(group)}
                        >
                          <CalendarClock className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
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
              onClick={(e) => handleRowClick(group, e)}
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
                    {getVisibilityBadge(group)}
                    {getTypeBadge(group.type)}
                    {group.cyclus_id && group.has_slots && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title={t('editEndDate.title', 'Einddatum aanpassen')}
                        onClick={(e) => { e.stopPropagation(); setEditEndDateGroup(group); }}
                      >
                        <CalendarClock className="h-4 w-4" />
                      </Button>
                    )}
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

      <EditCycleEndDateDialog
        open={!!editEndDateGroup}
        onOpenChange={(o) => { if (!o) setEditEndDateGroup(null); }}
        cyclusId={editEndDateGroup?.cyclus_id ?? null}
        cyclusName={editEndDateGroup?.cyclus_name ?? ''}
        onSaved={fetchCyclusData}
      />

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

      <BulkBookingModeDialog
        open={bookingModeDialogOpen}
        onOpenChange={setBookingModeDialogOpen}
        selectedCount={selectedIds.size}
        busy={bulkUpdating}
        onApply={handleBulkBookingMode}
      />

      <Dialog open={deleteDialogOpen} onOpenChange={(o) => { if (!bulkUpdating) { setDeleteDialogOpen(o); if (!o) setForceDeleteBooked(false); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('cyclesTab.bulkDelete.confirmTitle', { count: selectedIds.size, defaultValue: 'Delete {{count}} cycli?' })}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            {t('cyclesTab.bulkDelete.confirmBody', { defaultValue: 'This permanently deletes the selected cycli and their open slots. Any cyclus that still has player bookings is skipped (never auto-cancelled) and reported back. This cannot be undone.' })}
          </p>
          {selectedBookedCount > 0 && (
            <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <Checkbox
                  checked={forceDeleteBooked}
                  onCheckedChange={(v) => setForceDeleteBooked(v === true)}
                  disabled={bulkUpdating}
                  className="mt-0.5"
                />
                <span className="font-medium">{t('cyclesTab.bulkDelete.forceBooked')}</span>
              </label>
              {forceDeleteBooked && (
                <p className="text-sm font-medium text-destructive">
                  {t('cyclesTab.bulkDelete.forceWarning', { count: selectedBookedCount })}
                </p>
              )}
            </div>
          )}
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
