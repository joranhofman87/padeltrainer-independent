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
import { useToast } from '@/hooks/use-toast';
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
  first_slot_id: string;
}

type TimeFilter = 'current' | 'future' | 'past' | 'all';

export default function AcademyCyclusOverview() {
  const { t, i18n } = useTranslation('trainer');
  const navigate = useNavigate();
  const { toast } = useToast();
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
      if (trainerIds.length === 0) {
        setGroups([]);
        setLoading(false);
        return;
      }

      // Fetch trainer names
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
      const trainerNameMap: Record<string, string> = {};
      (trainerProfiles || []).forEach((tp: any) => {
        trainerNameMap[tp.id] = nameMap[tp.user_id] || 'Unknown';
      });

      // Fetch all slots that belong to a cyclus
      const { data: slots, error } = await supabase
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

      if (error) throw error;

      // Fetch booking data for player names
      const slotIds = slots?.map(s => s.id) || [];
      let playerNamesMap: Record<string, string[]> = {};
      let bookingCountMap: Record<string, number> = {};

      if (slotIds.length > 0) {
        // Batch in chunks of 500 to avoid query limits
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

      // Group by cyclus_id
      const cyclusMap = new Map<string, typeof slots>();
      (slots || []).forEach(slot => {
        const cid = (slot as any).cyclus_id as string;
        if (!cyclusMap.has(cid)) cyclusMap.set(cid, []);
        cyclusMap.get(cid)!.push(slot);
      });

      const now = new Date();
      const grouped: CyclusGroup[] = [];

      cyclusMap.forEach((cyclusSlots, cyclusId) => {
        const first = cyclusSlots[0];
        const last = cyclusSlots[cyclusSlots.length - 1];

        // Derive day/time from first slot
        const startDate = parseISO(first.start_time);
        const endDate = parseISO(first.end_time);
        const dayName = format(startDate, 'EEEE', { locale: dateLocale });
        const timeRange = `${format(startDate, 'HH:mm')} - ${format(endDate, 'HH:mm')}`;

        // Collect unique player names across all slots
        const allPlayerNames = new Set<string>();
        let maxBooked = 0;
        cyclusSlots.forEach(s => {
          const names = playerNamesMap[s.id] || [];
          names.forEach(n => allPlayerNames.add(n));
          const count = bookingCountMap[s.id] || 0;
          if (count > maxBooked) maxBooked = count;
        });

        grouped.push({
          cyclus_id: cyclusId,
          cyclus_name: (first as any).cyclus_name || cyclusId,
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
    navigate(`/app/academy/slot/${group.first_slot_id}`);
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
                    <TableCell className="font-medium max-w-[200px] truncate">
                      {group.cyclus_name}
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
                      {group.sessions}
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
                      <Badge variant={group.max_booked >= group.max_participants ? 'destructive' : 'secondary'}>
                        {group.max_booked}/{group.max_participants}
                      </Badge>
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
