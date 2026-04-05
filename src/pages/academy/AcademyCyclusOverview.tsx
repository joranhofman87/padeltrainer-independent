import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { format, parseISO } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { Search, Users } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { logger } from '@/lib/logger';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { useTableSort } from '@/hooks/useTableSort';
import { SortableTableHead } from '@/components/admin/SortableTableHead';
import { formatPrice } from '@/lib/pricing';

interface CyclusGroup {
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
  first_slot_id: string | null;
  status: string;
  type: string;
  has_slots: boolean;
}

type TimeFilter = 'current' | 'future' | 'past' | 'all';

export default function AcademyCyclusOverview() {
  const { t, i18n } = useTranslation('trainer');
  const navigate = useNavigate();
  const { activeAcademy } = useAcademyContext();
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState<CyclusGroup[]>([]);

  // Filters
  const [search, setSearch] = useState('');
  const [filterTrainer, setFilterTrainer] = useState('all');
  const [filterLocation, setFilterLocation] = useState('all');
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('current');

  const dateLocale = i18n.language === 'nl' ? nl : enUS;

  // Extract unique trainers/locations for filters
  const trainers = useMemo(() => {
    const map = new Map<string, string>();
    groups.forEach(g => map.set(g.trainer_id, g.trainer_name));
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
        let nameMap: Record<string, string> = {};
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
      let allSlots: any[] = [];
      if (trainerIds.length > 0) {
        const { data: slots } = await supabase
          .from('availability_slots')
          .select(`
            id, start_time, end_time, max_participants,
            cyclus_id, cyclus_name, trainer_id,
            price_per_session,
            location_id, locations:location_id(name)
          `)
          .in('trainer_id', trainerIds)
          .not('cyclus_id', 'is', null)
          .order('start_time', { ascending: true });
        allSlots = slots || [];
      }

      // Group slots by cyclus_id
      const slotsByCyclus = new Map<string, any[]>();
      allSlots.forEach(slot => {
        const cid = slot.cyclus_id as string;
        if (!slotsByCyclus.has(cid)) slotsByCyclus.set(cid, []);
        slotsByCyclus.get(cid)!.push(slot);
      });

      // 3. Fetch booking data for player names
      const slotIds = allSlots.map(s => s.id);
      let playerNamesMap: Record<string, string[]> = {};
      let bookingCountMap: Record<string, number> = {};

      if (slotIds.length > 0) {
        for (let i = 0; i < slotIds.length; i += 500) {
          const chunk = slotIds.slice(i, i + 500);
          const { data: bookings } = await supabase
            .from('bookings')
            .select('slot_id, player_id, guest_player_id')
            .in('slot_id', chunk)
            .in('status', ['confirmed', 'pending']);

          const playerIds = [...new Set((bookings || []).map(b => b.player_id).filter(Boolean))] as string[];
          let playerNameLookup: Record<string, string> = {};
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
          let guestNameLookup: Record<string, string> = {};
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
            const name = (b.player_id && playerNameLookup[b.player_id]) || (b.guest_player_id && guestNameLookup[b.guest_player_id]) || null;
            if (name) {
              if (!playerNamesMap[b.slot_id]) playerNamesMap[b.slot_id] = [];
              playerNamesMap[b.slot_id].push(name);
            }
          });
        }
      }

      // 4. Also fetch intake requests for cycles without slots (to show registered players)
      let intakePlayerMap: Record<string, string[]> = {};
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
            let intakePlayerLookup: Record<string, string> = {};
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
            let intakeGuestLookup: Record<string, string> = {};
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

      // 5. Build grouped results
      const grouped: CyclusGroup[] = [];
      const processedCyclusIds = new Set<string>();

      // Process cycles from cycles table
      cycleMap.forEach((cycle, cycleId) => {
        processedCyclusIds.add(cycleId);
        const cyclusSlots = slotsByCyclus.get(cycleId) || [];
        const hasSlots = cyclusSlots.length > 0;

        // Determine trainer from cycle owner or first slot
        let trainerId = '';
        let trainerName = 'Unknown';
        if (cycle.owner_type === 'trainer' && trainerNameMap[cycle.owner_id]) {
          trainerId = cycle.owner_id;
          trainerName = trainerNameMap[cycle.owner_id];
        } else if (hasSlots) {
          trainerId = cyclusSlots[0].trainer_id;
          trainerName = trainerNameMap[cyclusSlots[0].trainer_id] || 'Unknown';
        }

        // Location from slots or cycle
        let locationName: string | null = null;
        if (hasSlots) {
          locationName = (cyclusSlots[0].locations as any)?.name || null;
        } else if (cycle.locations) {
          locationName = (cycle.locations as any)?.name || null;
        }

        // Day/time from first slot
        let dayTime = '—';
        if (hasSlots) {
          const startDate = parseISO(cyclusSlots[0].start_time);
          const endDate = parseISO(cyclusSlots[0].end_time);
          const dayName = format(startDate, 'EEEE', { locale: dateLocale });
          dayTime = `${dayName} ${format(startDate, 'HH:mm')} - ${format(endDate, 'HH:mm')}`;
        }

        // Period
        const periodStart = hasSlots ? cyclusSlots[0].start_time : cycle.start_date;
        const periodEnd = hasSlots ? cyclusSlots[cyclusSlots.length - 1].start_time : cycle.end_date;

        // Players from both bookings and intake requests
        const allPlayerNames = new Set<string>();
        let maxBooked = 0;
        cyclusSlots.forEach((s: any) => {
          const names = playerNamesMap[s.id] || [];
          names.forEach((n: string) => allPlayerNames.add(n));
          const count = bookingCountMap[s.id] || 0;
          if (count > maxBooked) maxBooked = count;
        });
        // Also add intake players
        const intakePlayers = intakePlayerMap[cycleId] || [];
        intakePlayers.forEach(n => allPlayerNames.add(n));

        // Price from cycle or first slot
        const pricePerSession = cycle.price_per_session ?? (hasSlots ? cyclusSlots[0].price_per_session : null);

        grouped.push({
          cyclus_id: cycleId,
          cyclus_name: cycle.name || cycleId,
          trainer_name: trainerName,
          trainer_id: trainerId,
          location_name: locationName,
          day_time: dayTime,
          period_start: periodStart,
          period_end: periodEnd,
          sessions: cyclusSlots.length,
          player_names: Array.from(allPlayerNames).sort(),
          player_count: allPlayerNames.size,
          price_per_session: pricePerSession,
          max_participants: hasSlots ? (cyclusSlots[0].max_participants || 4) : 4,
          max_booked: maxBooked,
          first_slot_id: hasSlots ? cyclusSlots[0].id : null,
          status: cycle.status || 'draft',
          type: cycle.type || 'cyclus',
          has_slots: hasSlots,
        });
      });

      // Process orphan slot groups (cyclus_id not in cycles table)
      slotsByCyclus.forEach((cyclusSlots, cyclusId) => {
        if (processedCyclusIds.has(cyclusId)) return;

        const first = cyclusSlots[0];
        const last = cyclusSlots[cyclusSlots.length - 1];

        const startDate = parseISO(first.start_time);
        const endDate = parseISO(first.end_time);
        const dayName = format(startDate, 'EEEE', { locale: dateLocale });
        const timeRange = `${format(startDate, 'HH:mm')} - ${format(endDate, 'HH:mm')}`;

        const allPlayerNames = new Set<string>();
        let maxBooked = 0;
        cyclusSlots.forEach((s: any) => {
          const names = playerNamesMap[s.id] || [];
          names.forEach((n: string) => allPlayerNames.add(n));
          const count = bookingCountMap[s.id] || 0;
          if (count > maxBooked) maxBooked = count;
        });

        grouped.push({
          cyclus_id: cyclusId,
          cyclus_name: first.cyclus_name || cyclusId,
          trainer_name: trainerNameMap[first.trainer_id] || 'Unknown',
          trainer_id: first.trainer_id,
          location_name: (first.locations as any)?.name || null,
          day_time: `${dayName} ${timeRange}`,
          period_start: first.start_time,
          period_end: last.start_time,
          sessions: cyclusSlots.length,
          player_names: Array.from(allPlayerNames).sort(),
          player_count: allPlayerNames.size,
          price_per_session: first.price_per_session,
          max_participants: first.max_participants || 4,
          max_booked: maxBooked,
          first_slot_id: first.id,
          status: 'active',
          type: 'cyclus',
          has_slots: true,
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
      const start = parseISO(g.period_start);
      const end = parseISO(g.period_end);
      switch (timeFilter) {
        case 'current': return start <= now && end >= now;
        case 'future': return start > now;
        case 'past': return end < now;
        case 'all': return true;
        default: return true;
      }
    });
  }, [groups, timeFilter]);

  // Apply filters
  const filtered = useMemo(() => {
    return timeFiltered.filter(g => {
      if (filterTrainer !== 'all' && g.trainer_id !== filterTrainer) return false;
      if (filterLocation !== 'all' && g.location_name !== filterLocation) return false;
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
  }, [timeFiltered, filterTrainer, filterLocation, search]);

  const { sortedData, sortConfig, handleSort } = useTableSort(filtered);

  const handleRowClick = (group: CyclusGroup) => {
    if (group.first_slot_id) {
      navigate(`/app/academy/slot/${group.first_slot_id}`);
    } else {
      navigate(`/app/academy/registrations?cycle=${group.cyclus_id}`);
    }
  };

  const getStatusBadge = (group: CyclusGroup) => {
    if (!group.has_slots && group.sessions === 0) {
      return <Badge variant="outline" className="text-xs">Geen sessies</Badge>;
    }
    return (
      <Badge variant={group.max_booked >= group.max_participants ? 'destructive' : 'secondary'}>
        {group.max_booked}/{group.max_participants}
      </Badge>
    );
  };

  const getTypeBadge = (type: string) => {
    switch (type) {
      case 'registration': return <Badge variant="outline" className="text-xs">Registratie</Badge>;
      case 'event': return <Badge variant="outline" className="text-xs">Event</Badge>;
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
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t('calendar.searchPlaceholder', 'Search cycles, trainers, players...')}
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-9 h-9"
              />
            </div>

            <Select value={timeFilter} onValueChange={v => setTimeFilter(v as TimeFilter)}>
              <SelectTrigger className="w-[140px] h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="current">Huidig</SelectItem>
                <SelectItem value="future">Toekomstig</SelectItem>
                <SelectItem value="past">Afgelopen</SelectItem>
                <SelectItem value="all">Alle</SelectItem>
              </SelectContent>
            </Select>

            {trainers.length > 1 && (
              <Select value={filterTrainer} onValueChange={setFilterTrainer}>
                <SelectTrigger className="w-[160px] h-9">
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
                <SelectTrigger className="w-[160px] h-9">
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
          </div>
        </CardContent>
      </Card>

      {/* Summary */}
      <div className="text-sm text-muted-foreground">
        {sortedData.length} {sortedData.length === 1 ? 'cyclus' : 'cycli'}
      </div>

      {/* Table */}
      <Card>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead
                  sortKey="cyclus_name"
                  currentSortKey={sortConfig.key as string}
                  currentDirection={sortConfig.direction}
                  onSort={handleSort as (key: string) => void}
                >
                  Naam
                </SortableTableHead>
                <SortableTableHead
                  sortKey="trainer_name"
                  currentSortKey={sortConfig.key as string}
                  currentDirection={sortConfig.direction}
                  onSort={handleSort as (key: string) => void}
                >
                  Trainer
                </SortableTableHead>
                <TableHead>Locatie</TableHead>
                <TableHead>Dag / Tijd</TableHead>
                <SortableTableHead
                  sortKey="period_start"
                  currentSortKey={sortConfig.key as string}
                  currentDirection={sortConfig.direction}
                  onSort={handleSort as (key: string) => void}
                >
                  Periode
                </SortableTableHead>
                <SortableTableHead
                  sortKey="sessions"
                  currentSortKey={sortConfig.key as string}
                  currentDirection={sortConfig.direction}
                  onSort={handleSort as (key: string) => void}
                >
                  Sessies
                </SortableTableHead>
                <SortableTableHead
                  sortKey="player_count"
                  currentSortKey={sortConfig.key as string}
                  currentDirection={sortConfig.direction}
                  onSort={handleSort as (key: string) => void}
                >
                  Spelers
                </SortableTableHead>
                <TableHead>Prijs</TableHead>
                <TableHead>Bezetting</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedData.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-12">
                    Geen cycli gevonden
                  </TableCell>
                </TableRow>
              ) : (
                sortedData.map((group) => (
                  <TableRow
                    key={group.cyclus_id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => handleRowClick(group)}
                  >
                    <TableCell className="font-medium max-w-[200px]">
                      <div className="flex items-center gap-2">
                        <span className="truncate">{group.cyclus_name}</span>
                        {getTypeBadge(group.type)}
                      </div>
                    </TableCell>
                    <TableCell>{group.trainer_name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {group.location_name || '—'}
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">
                      {group.day_time}
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">
                      {format(parseISO(group.period_start), 'd MMM', { locale: dateLocale })}
                      {' → '}
                      {format(parseISO(group.period_end), 'd MMM yyyy', { locale: dateLocale })}
                    </TableCell>
                    <TableCell className="text-center">
                      {group.sessions > 0 ? group.sessions : '—'}
                    </TableCell>
                    <TableCell>
                      {group.player_count > 0 ? (
                        <div className="flex items-center gap-1.5">
                          <Users className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-sm">{group.player_names.slice(0, 3).join(', ')}</span>
                          {group.player_names.length > 3 && (
                            <Badge variant="secondary" className="text-xs">
                              +{group.player_names.length - 3}
                            </Badge>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {group.price_per_session != null
                        ? formatPrice(group.price_per_session)
                        : <span className="text-muted-foreground">—</span>
                      }
                    </TableCell>
                    <TableCell>
                      {getStatusBadge(group)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
