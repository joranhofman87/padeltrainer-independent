import { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Users, UserPlus, Upload, Mail, Phone, RefreshCw, Columns3, Tags } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { getAcademyLocations } from '@/lib/academy';
import {
  usePlayersOverview,
  fetchPlayersOverview,
  fetchAllPlayersOverview,
  type PlayersOverviewRow,
  type PlayersOverviewFilters,
  type LevelBand,
} from '@/lib/playersOverview';
import { playerKeys, invalidateAllPlayerData } from '@/lib/playerQueryKeys';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { supabase } from '@/lib/supabaseClient';
import { format } from 'date-fns';
import { SortableHeader } from '@/components/players/usePlayerSort';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';
import { AppPage } from '@/components/ui/app-page';
import { PageHeader } from '@/components/ui/page-header';
import { TableToolbar } from '@/components/ui/table-toolbar';
import { compactDataTableClass, DataTableCard } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { ListPageSkeleton } from '@/components/ui/list-page-skeleton';
import { AddPlayerDialog, GuestPlayer } from '@/components/trainer/AddPlayerDialog';
import { AddPlayerForm } from '@/components/trainer/AddPlayerForm';
import { ImportPlayersDialog } from '@/components/trainer/ImportPlayersDialog';
import { useSearchParams, Link } from 'react-router-dom';
import { Skeleton } from '@/components/ui/skeleton';
import { PlayerTagsCell } from '@/components/players/PlayerTagsCell';
import { PlayerNotesCell } from '@/components/players/PlayerNotesCell';
import { ManagePlayerTagsDialog } from '@/components/players/ManagePlayerTagsDialog';
import { PlayerTag, getTagColorClass } from '@/components/players/playerTagColors';
import { cn } from '@/lib/utils';

// Lazy: pulls in the heavy TipTap editor chunk — only load when the tab is opened
const EmailCampaignTab = lazy(() =>
  import('@/components/players/EmailCampaignTab').then((m) => ({ default: m.EmailCampaignTab }))
);

interface TrainerOption {
  id: string;
  name: string;
}

type UnifiedPlayer = {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  billing_business_name: string | null;
  skill_rating: number | null;
  rating_system: string;
  has_trained: boolean;
  notes: string | null;
  created_at: string;
  type: 'guest' | 'registered';
  trainer_id?: string;
  trainer_ids?: string[];
  trainer_name?: string;
  originalGuest?: GuestPlayer;
  location_names?: string[];
  training_location_ids?: string[];
  has_active_cyclus?: boolean;
  source?: string | null;
  birth_date?: string | null;
  // Tags & metadata (academy-level)
  metadata_id?: string;
  tag_ids?: string[];
  academy_notes?: string;
  // Stable keys for metadata lookup
  guest_player_id?: string | null;
  profile_id?: string | null;
  has_overdue_payment?: boolean;
};

function getLevelLabel(band: string, t: (key: string, defaultValue: string) => string): string {
  switch (band) {
    case 'beginner': return t('players.levels.beginner', 'Beginner (1-3)');
    case 'intermediate': return t('players.levels.intermediate', 'Intermediate (4-6)');
    case 'advanced': return t('players.levels.advanced', 'Advanced (7-9)');
    case 'pro': return t('players.levels.pro', 'Pro (9+)');
    case 'unrated': return t('players.levels.unrated', 'Unrated');
    default: return band;
  }
}

export default function AcademyPlayers() {
  const { t } = useTranslation('academy');
  const { t: tTrainer } = useTranslation('trainer');
  const { activeAcademy } = useAcademyContext();
  const [searchParams, setSearchParams] = useSearchParams();

  const activeTab = searchParams.get('tab') || 'all-players';
  const setActiveTab = (tab: string) => {
    setSearchParams({ tab });
  };

  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearch = useDebouncedValue(searchQuery);

  // Trainer selector
  const [trainers, setTrainers] = useState<TrainerOption[]>([]);
  const [selectedTrainerId, setSelectedTrainerId] = useState<string>('');

  // Filters (server-side via the players-overview RPC)
  const [selectedLocation, setSelectedLocation] = useState<string>('all');
  const [selectedLevel, setSelectedLevel] = useState<string>('all');
  const [selectedCyclus, setSelectedCyclus] = useState<string>('all');
  const [selectedTagId, setSelectedTagId] = useState<string>('all');
  const [selectedPaymentStatus, setSelectedPaymentStatus] = useState<string>('all');
  const [allLocations, setAllLocations] = useState<{ id: string; name: string }[]>([]);

  // Server-side sort + pagination
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState<'name' | 'email' | 'skill' | 'addedOn'>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const toggleSort = (key: string) => {
    const k = key as 'name' | 'email' | 'skill' | 'addedOn';
    if (k === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(k);
      setSortDir('asc');
    }
  };

  // Tags
  const [tags, setTags] = useState<PlayerTag[]>([]);
  const [showManageTags, setShowManageTags] = useState(false);

  // Dialogs
  const [showAddPlayer, setShowAddPlayer] = useState(false);
  const [showImportPlayers, setShowImportPlayers] = useState(false);

  // Column customization
  type ColumnKey =
    | 'email' | 'phone' | 'location' | 'addedOn'
    | 'trainer' | 'skill' | 'status' | 'cyclus' | 'type' | 'notes' | 'source' | 'birthDate' | 'tags' | 'internalNotes';
  const DEFAULT_COLUMNS: ColumnKey[] = ['tags', 'internalNotes', 'email', 'phone', 'location', 'addedOn'];
  const ALL_COLUMNS: { key: ColumnKey; label: string; isDefault: boolean }[] = [
    { key: 'tags', label: tTrainer('players.columns.tags', 'Tags'), isDefault: true },
    { key: 'internalNotes', label: tTrainer('players.columns.internalNotes', 'Internal notes'), isDefault: true },
    { key: 'email', label: tTrainer('players.columns.email', 'Email'), isDefault: true },
    { key: 'phone', label: tTrainer('players.columns.phone', 'Phone'), isDefault: true },
    { key: 'location', label: tTrainer('players.columns.location', 'Location'), isDefault: true },
    { key: 'addedOn', label: tTrainer('players.columns.addedOn', 'Date added'), isDefault: true },
    { key: 'trainer', label: tTrainer('players.columns.trainer', 'Trainer'), isDefault: false },
    { key: 'skill', label: tTrainer('players.columns.skill', 'Skill rating'), isDefault: false },
    { key: 'status', label: tTrainer('players.columns.status', 'Status'), isDefault: false },
    { key: 'cyclus', label: tTrainer('players.columns.cyclus', 'In active cyclus'), isDefault: false },
    { key: 'type', label: tTrainer('players.columns.type', 'Type'), isDefault: false },
    { key: 'notes', label: tTrainer('players.columns.notes', 'Notes (intake)'), isDefault: false },
    { key: 'source', label: tTrainer('players.columns.source', 'Source'), isDefault: false },
    { key: 'birthDate', label: tTrainer('players.columns.birthDate', 'Birth date'), isDefault: false },
  ];
  const storageKey = activeAcademy ? `academyPlayers:visibleColumns:${activeAcademy.id}` : null;
  const [visibleColumns, setVisibleColumns] = useState<ColumnKey[]>(DEFAULT_COLUMNS);

  useEffect(() => {
    if (!storageKey) return;
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as ColumnKey[];
        const valid = parsed.filter((k) => ALL_COLUMNS.some((c) => c.key === k));
        if (valid.length) setVisibleColumns(valid);
      }
    } catch { /* non-fatal: fall back to default columns if stored prefs are unreadable */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const toggleColumn = (key: ColumnKey) => {
    setVisibleColumns((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      if (storageKey) {
        try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* non-fatal: best-effort persistence of column prefs */ }
      }
      return next;
    });
  };

  const isColVisible = (key: ColumnKey) => visibleColumns.includes(key);

  // Fetch trainers, tags and academy locations (filter dropdowns)
  useEffect(() => {
    if (!activeAcademy) return;
    fetchTrainers();
    fetchTags();
    fetchLocations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAcademy]);

  const fetchTags = async () => {
    if (!activeAcademy) return;
    const { data } = await supabase
      .from('academy_player_tags')
      .select('*')
      .eq('academy_profile_id', activeAcademy.id)
      .order('name');
    setTags((data || []) as PlayerTag[]);
  };

  const fetchLocations = async () => {
    if (!activeAcademy) return;
    const rows = await getAcademyLocations(activeAcademy.id);
    const locs = rows
      .map((row: { location?: { id: string; name: string } }) => row.location)
      .filter((l): l is { id: string; name: string } => Boolean(l?.id && l?.name));
    setAllLocations(locs.sort((a, b) => a.name.localeCompare(b.name)));
  };

  // Tag/notes edits refresh every player view through the central subtree.
  const handlePlayerDataChanged = () => {
    if (activeAcademy) invalidateAllPlayerData(queryClient, { kind: 'academy', id: activeAcademy.id });
  };

  const trainerNameMap = useMemo(() => new Map(trainers.map((tr) => [tr.id, tr.name])), [trainers]);

  // Server-side overview: search, filters, sort and pagination all happen in
  // the get_players_overview RPC — one round trip, exact totals, no 1000-row
  // truncation. Removal filtering (removed_at) is enforced in SQL.
  const overviewFilters: PlayersOverviewFilters = useMemo(() => ({
    trainerId: selectedTrainerId && selectedTrainerId !== 'all' ? selectedTrainerId : null,
    locationId: selectedLocation !== 'all' ? selectedLocation : null,
    levelBand: selectedLevel !== 'all' ? (selectedLevel as LevelBand) : null,
    hasActiveCyclus: selectedCyclus === 'yes' ? true : selectedCyclus === 'no' ? false : null,
    tagId: selectedTagId !== 'all' ? selectedTagId : null,
    payment: selectedPaymentStatus !== 'all' ? (selectedPaymentStatus as 'overdue' | 'ok') : null,
  }), [selectedTrainerId, selectedLocation, selectedLevel, selectedCyclus, selectedTagId, selectedPaymentStatus]);

  // Snap back to the first page whenever the result set changes shape.
  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, overviewFilters]);

  const rpcSort = sortKey === 'addedOn' ? 'created_at' : sortKey;
  const { data: overview, isLoading: loading } = usePlayersOverview(
    { kind: 'academy', id: activeAcademy?.id },
    { search: debouncedSearch, filters: overviewFilters, sort: rpcSort, sortDir, page, pageSize: PAGE_SIZE },
  );
  const totalFiltered = overview?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalFiltered / PAGE_SIZE));

  const sortedPlayers: UnifiedPlayer[] = useMemo(() => {
    return (overview?.rows ?? []).map((row: PlayersOverviewRow) => ({
      id: row.guest_player_id ?? `reg-${row.profile_id}`,
      full_name: row.full_name,
      email: row.email,
      phone: row.phone,
      billing_business_name: row.billing_business_name,
      skill_rating: row.skill_rating,
      rating_system: row.rating_system,
      has_trained: row.has_trained,
      notes: row.notes,
      created_at: row.created_at,
      type: row.player_type as 'guest' | 'registered',
      trainer_id: row.owner_trainer_id ?? undefined,
      trainer_ids: row.trainer_ids ?? [],
      trainer_name: row.player_type === 'guest'
        ? (row.owner_trainer_id ? (trainerNameMap.get(row.owner_trainer_id) || '—') : t('nav.academy', 'Academy'))
        : (row.trainer_ids?.length ? trainerNameMap.get(row.trainer_ids[0]) || '—' : '—'),
      location_names: row.location_names ?? [],
      training_location_ids: row.location_ids ?? [],
      has_active_cyclus: row.has_active_cyclus,
      source: row.source,
      birth_date: row.birth_date,
      metadata_id: row.metadata_id ?? undefined,
      tag_ids: row.tag_ids ?? [],
      academy_notes: row.academy_notes ?? '',
      guest_player_id: row.guest_player_id,
      profile_id: row.profile_id,
      has_overdue_payment: row.has_overdue_payment,
    }));
  }, [overview, trainerNameMap, t]);

  // Header count: unfiltered active-player total (removal already applied by
  // the RPC), independent of the table's search/filters.
  const { data: activePlayerCount = 0 } = useQuery({
    queryKey: playerKeys.count('academy', activeAcademy?.id),
    queryFn: async () => {
      const { total } = await fetchPlayersOverview(
        { kind: 'academy', id: activeAcademy!.id },
        { pageSize: 1 },
      );
      return total;
    },
    enabled: !!activeAcademy,
  });

  // Email campaign needs the COMPLETE player list (recipient selection) —
  // fetched via deterministic page-through, so no silent 1000-row cap.
  const { data: campaignPlayers = [] } = useQuery({
    queryKey: playerKeys.campaignAll('academy', activeAcademy?.id),
    queryFn: () => fetchAllPlayersOverview({ kind: 'academy', id: activeAcademy!.id }),
    enabled: !!activeAcademy && activeTab === 'email-campaign',
  });

  const fetchTrainers = async () => {
    if (!activeAcademy) return;

    const { data: academyTrainers } = await supabase
      .from('academy_trainers')
      .select('trainer_profile_id')
      .eq('academy_profile_id', activeAcademy.id)
      .eq('status', 'active');

    const trainerIds = academyTrainers?.map((t) => t.trainer_profile_id) || [];
    if (trainerIds.length === 0) {
      setTrainers([]);
      return;
    }

    const { data: trainerProfiles } = await supabase
      .from('trainer_profiles')
      .select('id, user_id')
      .in('id', trainerIds);

    if (!trainerProfiles || trainerProfiles.length === 0) {
      setTrainers([]);
      return;
    }

    const userIds = trainerProfiles.map((tp) => tp.user_id);
    const { data: profiles } = await supabase
      .from('profiles')
      .select('user_id, full_name')
      .in('user_id', userIds);

    const nameMap = new Map(profiles?.map((p) => [p.user_id, p.full_name || 'Unknown']) || []);
    const opts: TrainerOption[] = trainerProfiles.map((tp) => ({
      id: tp.id,
      name: nameMap.get(tp.user_id) || 'Unknown',
    }));

    setTrainers(opts);
  };


  const handlePlayerCreated = (_player: GuestPlayer) => {
    handlePlayerDataChanged();
    setShowAddPlayer(false);
  };

  const handlePlayersImported = (_importedPlayers: GuestPlayer[]) => {
    handlePlayerDataChanged();
  };

  if (loading) {
    return (
      <AppPage>
        <ListPageSkeleton />
      </AppPage>
    );
  }

  return (
    <AppPage className="space-y-4">
      <PageHeader
        title={t('nav.players')}
        count={activePlayerCount}
        countLabel={{ one: tTrainer('players.countOne', 'player'), other: tTrainer('players.countOther', 'players') }}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setShowManageTags(true)} aria-label={tTrainer('players.tags.manageButton', 'Tags')}>
              <Tags className="h-4 w-4" />
              <span className="hidden sm:inline">{tTrainer('players.tags.manageButton', 'Tags')}</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowImportPlayers(true)} aria-label={tTrainer('players.import.button', 'Import')}>
              <Upload className="h-4 w-4" />
              <span className="hidden sm:inline">{tTrainer('players.import.button')}</span>
              <span className="sm:hidden">{tTrainer('players.import.shortLabel', 'Import')}</span>
            </Button>
            <Button size="sm" onClick={() => setShowAddPlayer(true)} aria-label={tTrainer('players.addPlayer', 'Add Player')}>
              <UserPlus className="h-4 w-4" />
              <span className="hidden sm:inline">{tTrainer('players.addPlayer')}</span>
              <span className="sm:hidden">{tTrainer('players.addShort', 'Add')}</span>
            </Button>
          </>
        }
      />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="flex items-center gap-3">
          <TabsList>
            <TabsTrigger value="all-players" className="gap-2">
              <Users className="h-4 w-4" />
              <span className="hidden sm:inline">{tTrainer('players.allPlayers', 'All Players')}</span>
            </TabsTrigger>
            <TabsTrigger value="create" className="gap-2">
              <UserPlus className="h-4 w-4" />
              <span className="hidden sm:inline">{tTrainer('players.create', 'Create')}</span>
            </TabsTrigger>
            <TabsTrigger value="email-campaign" className="gap-2">
              <Mail className="h-4 w-4" />
              <span className="hidden sm:inline">{tTrainer('players.emailCampaign', 'Email Campaign')}</span>
            </TabsTrigger>
          </TabsList>
        </div>

        {/* All Players Tab */}
        <TabsContent value="all-players" className="space-y-3 mt-3">
          <TableToolbar
            searchPlaceholder={tTrainer('players.searchPlayers')}
            searchValue={searchQuery}
            onSearchChange={setSearchQuery}
            trailing={
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="hidden md:inline-flex">
                    <Columns3 className="mr-2 h-4 w-4" />
                    {tTrainer('players.columns.button', 'Columns')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>{tTrainer('players.columns.default', 'Default')}</DropdownMenuLabel>
                  {ALL_COLUMNS.filter((c) => c.isDefault).map((c) => (
                    <DropdownMenuCheckboxItem
                      key={c.key}
                      checked={isColVisible(c.key)}
                      onCheckedChange={() => toggleColumn(c.key)}
                      onSelect={(e) => e.preventDefault()}
                    >
                      {c.label}
                    </DropdownMenuCheckboxItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>{tTrainer('players.columns.optional', 'Optional')}</DropdownMenuLabel>
                  {ALL_COLUMNS.filter((c) => !c.isDefault).map((c) => (
                    <DropdownMenuCheckboxItem
                      key={c.key}
                      checked={isColVisible(c.key)}
                      onCheckedChange={() => toggleColumn(c.key)}
                      onSelect={(e) => e.preventDefault()}
                    >
                      {c.label}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            }
          >
            {trainers.length > 0 && (
              <Select value={selectedTrainerId} onValueChange={setSelectedTrainerId}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder={tTrainer('players.allTrainers', 'All Trainers')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{tTrainer('players.allTrainers', 'All Trainers')}</SelectItem>
                  {trainers.map((tr) => (
                    <SelectItem key={tr.id} value={tr.id}>
                      {tr.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {allLocations.length > 0 && (
              <Select value={selectedLocation} onValueChange={setSelectedLocation}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder={tTrainer('players.allLocations', 'All Locations')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{tTrainer('players.allLocations', 'All Locations')}</SelectItem>
                  {allLocations.map((loc) => (
                    <SelectItem key={loc.id} value={loc.id}>
                      {loc.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <Select value={selectedLevel} onValueChange={setSelectedLevel}>
              <SelectTrigger className="w-[170px]">
                <SelectValue placeholder={tTrainer('players.allLevels', 'All Levels')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tTrainer('players.allLevels', 'All Levels')}</SelectItem>
                <SelectItem value="beginner">{getLevelLabel('beginner', tTrainer)}</SelectItem>
                <SelectItem value="intermediate">{getLevelLabel('intermediate', tTrainer)}</SelectItem>
                <SelectItem value="advanced">{getLevelLabel('advanced', tTrainer)}</SelectItem>
                <SelectItem value="pro">{getLevelLabel('pro', tTrainer)}</SelectItem>
                <SelectItem value="unrated">{getLevelLabel('unrated', tTrainer)}</SelectItem>
              </SelectContent>
            </Select>

            <Select value={selectedCyclus} onValueChange={setSelectedCyclus}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder={tTrainer('players.activeCyclus', 'Active Cyclus')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tTrainer('players.allCyclus', 'All')}</SelectItem>
                <SelectItem value="yes">{tTrainer('players.hasCyclus', 'Has Cyclus')}</SelectItem>
                <SelectItem value="no">{tTrainer('players.noCyclus', 'No Cyclus')}</SelectItem>
              </SelectContent>
            </Select>

            <Select value={selectedTagId} onValueChange={setSelectedTagId}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder={tTrainer('players.tags.filterAll', 'All Tags')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tTrainer('players.tags.filterAll', 'All Tags')}</SelectItem>
                <SelectItem value="untagged">{tTrainer('players.tags.untagged', 'Untagged')}</SelectItem>
                {tags.map((tag) => (
                  <SelectItem key={tag.id} value={tag.id}>
                    <span className={cn('inline-block h-2 w-2 rounded-full mr-2', getTagColorClass(tag.color).split(' ').filter(c => c.startsWith('bg-')).join(' '))} />
                    {tag.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={selectedPaymentStatus} onValueChange={setSelectedPaymentStatus}>
              <SelectTrigger className="w-[170px]">
                <SelectValue placeholder={tTrainer('players.payment.filterAll', 'Payment status')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tTrainer('players.payment.filterAll', 'All payments')}</SelectItem>
                <SelectItem value="overdue">{tTrainer('players.payment.overdue', 'Overdue')}</SelectItem>
                <SelectItem value="ok">{tTrainer('players.payment.ok', 'No overdue')}</SelectItem>
              </SelectContent>
            </Select>
          </TableToolbar>

          {/* Players Table */}
          {sortedPlayers.length === 0 ? (
            <Card className="overflow-hidden border-border/80 shadow-sm">
              <EmptyState
                icon={Users}
                title={searchQuery ? tTrainer('players.noPlayersFound') : tTrainer('players.empty', 'No players yet')}
                description={
                  searchQuery
                    ? tTrainer('players.tryDifferentSearch')
                    : tTrainer('players.emptyDescription', 'Players will appear here once they book with your trainers.')
                }
                action={
                  !searchQuery ? (
                    <Button onClick={() => setShowAddPlayer(true)}>
                      <UserPlus className="mr-2 h-4 w-4" />
                      {tTrainer('players.addPlayer')}
                    </Button>
                  ) : undefined
                }
              />
            </Card>
          ) : (
            <DataTableCard
              testId="academy-players-table-scroll"
              mobile={
                <div className="md:hidden space-y-3 p-4">
                  {sortedPlayers.map((player) => (
                    <div key={player.id} className="border rounded-lg p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium truncate">{player.full_name}</p>
                          {player.trainer_name && (
                            <p className="text-xs text-muted-foreground">{player.trainer_name}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {player.type === 'registered' ? (
                            <Badge variant="default" className="text-xs">{tTrainer('players.statuses.registered')}</Badge>
                          ) : player.has_trained ? (
                            <Badge variant="secondary" className="text-xs">{tTrainer('players.statuses.active')}</Badge>
                          ) : (
                            <Badge variant="outline" className="text-xs">{tTrainer('players.statuses.prospect')}</Badge>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                        {player.email && (
                          <span className="flex items-center gap-1">
                            <Mail className="h-3 w-3" /> {player.email}
                          </span>
                        )}
                        {player.phone && (
                          <span className="flex items-center gap-1">
                            <Phone className="h-3 w-3" /> {player.phone}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        {player.skill_rating && (
                          <Badge variant="secondary" className="text-xs">
                            {player.skill_rating.toFixed(1)} {player.rating_system?.toUpperCase()}
                          </Badge>
                        )}
                        {player.has_active_cyclus && (
                          <Badge variant="outline" className="text-xs border-primary/30 text-primary">
                            <RefreshCw className="h-3 w-3 mr-1" />
                            {tTrainer('players.cyclusBadge', 'Cyclus')}
                          </Badge>
                        )}
                        <span>{format(new Date(player.created_at), 'MMM d, yyyy')}</span>
                      </div>
                    </div>
                  ))}
                </div>
              }
            >
                <Table className={compactDataTableClass}>
                  <TableHeader className="sticky top-0 bg-background z-10">
                    <TableRow>
                      <SortableHeader sortKey="name" activeKey={sortKey} direction={sortDir} onToggle={toggleSort}>
                        {tTrainer('players.name')}
                      </SortableHeader>
                      {visibleColumns.map((key) => {
                        const col = ALL_COLUMNS.find((c) => c.key === key);
                        if (!col) return null;
                        if (key === 'email') {
                          return (
                            <SortableHeader key={key} sortKey="email" activeKey={sortKey} direction={sortDir} onToggle={toggleSort}>
                              {col.label}
                            </SortableHeader>
                          );
                        }
                        if (key === 'skill') {
                          return (
                            <SortableHeader key={key} sortKey="skill" activeKey={sortKey} direction={sortDir} onToggle={toggleSort}>
                              {col.label}
                            </SortableHeader>
                          );
                        }
                        if (key === 'addedOn') {
                          return (
                            <SortableHeader key={key} sortKey="addedOn" activeKey={sortKey} direction={sortDir} onToggle={toggleSort}>
                              {col.label}
                            </SortableHeader>
                          );
                        }
                        return <TableHead key={key} className="whitespace-nowrap">{col.label}</TableHead>;
                      })}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedPlayers.map((player) => (
                      <TableRow key={player.id} className="h-10 max-h-10">
                        <TableCell className="font-medium whitespace-nowrap max-w-[260px] min-w-0 overflow-hidden" title={player.full_name}>
                          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                            <Link
                              to={`/app/academy/players/${player.guest_player_id ? `g_${player.guest_player_id}` : `p_${player.profile_id}`}`}
                              className="hover:underline text-foreground truncate"
                            >
                              {player.full_name}
                            </Link>
                            {player.has_overdue_payment && (
                              <Badge variant="destructive" className="h-5 px-1.5 text-[11px] shrink-0" title={tTrainer('players.payment.overdueTooltip', 'Has overdue invoice')}>
                                {tTrainer('players.payment.overdue', 'Overdue')}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        {visibleColumns.map((key) => {
                          switch (key) {
                            case 'email':
                              return (
                                <TableCell key={key} className="whitespace-nowrap max-w-[220px] min-w-0 overflow-hidden truncate" title={player.email || ''}>
                                  {player.email || <span className="text-muted-foreground">—</span>}
                                </TableCell>
                              );
                            case 'phone':
                              return (
                                <TableCell key={key} className="whitespace-nowrap overflow-hidden">
                                  {player.phone || <span className="text-muted-foreground">—</span>}
                                </TableCell>
                              );
                            case 'location':
                              return (
                                <TableCell key={key} className="text-muted-foreground whitespace-nowrap max-w-[180px] min-w-0 overflow-hidden truncate" title={player.location_names?.join(', ') || ''}>
                                  {player.location_names && player.location_names.length > 0
                                    ? player.location_names.join(', ')
                                    : '—'}
                                </TableCell>
                              );
                            case 'addedOn':
                              return (
                                <TableCell key={key} className="text-muted-foreground whitespace-nowrap">
                                  {format(new Date(player.created_at), 'dd-MM-yyyy')}
                                </TableCell>
                              );
                            case 'trainer':
                              return (
                                <TableCell key={key} className="text-muted-foreground whitespace-nowrap max-w-[160px] truncate" title={player.trainer_name || ''}>
                                  {player.trainer_name || '—'}
                                </TableCell>
                              );
                            case 'skill':
                              return (
                                <TableCell key={key} className="whitespace-nowrap">
                                  {player.skill_rating ? (
                                    <span className="inline-flex items-center gap-1">
                                      <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">{player.skill_rating.toFixed(1)}</Badge>
                                      <span className="text-[11px] text-muted-foreground uppercase">
                                        {player.rating_system || 'knltb'}
                                      </span>
                                    </span>
                                  ) : <span className="text-muted-foreground">—</span>}
                                </TableCell>
                              );
                            case 'status':
                              return (
                                <TableCell key={key} className="whitespace-nowrap">
                                  {player.type === 'registered' ? (
                                    <Badge variant="default" className="h-5 px-1.5 text-[11px]">{tTrainer('players.statuses.registered')}</Badge>
                                  ) : player.has_trained ? (
                                    <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">{tTrainer('players.statuses.active')}</Badge>
                                  ) : (
                                    <Badge variant="outline" className="h-5 px-1.5 text-[11px]">{tTrainer('players.statuses.prospect')}</Badge>
                                  )}
                                </TableCell>
                              );
                            case 'cyclus':
                              return (
                                <TableCell key={key} className="whitespace-nowrap">
                                  {player.has_active_cyclus ? (
                                    <Badge variant="outline" className="h-5 px-1.5 text-[11px] border-primary/30 text-primary">
                                      <RefreshCw className="h-2.5 w-2.5 mr-1" />
                                      {tTrainer('players.columns.cyclusYes', 'Yes')}
                                    </Badge>
                                  ) : <span className="text-muted-foreground">—</span>}
                                </TableCell>
                              );
                            case 'type':
                              return (
                                <TableCell key={key} className="whitespace-nowrap">
                                  <Badge variant="outline" className="h-5 px-1.5 text-[11px]">
                                    {player.type === 'guest'
                                      ? tTrainer('players.columns.typeGuest', 'Guest')
                                      : tTrainer('players.columns.typeRegistered', 'Registered')}
                                  </Badge>
                                </TableCell>
                              );
                            case 'notes':
                              return (
                                <TableCell key={key} className="text-muted-foreground max-w-[220px] min-w-0 overflow-hidden whitespace-nowrap">
                                  <div className="truncate" title={player.notes || ''}>
                                    {player.notes || '—'}
                                  </div>
                                </TableCell>
                              );
                            case 'source':
                              return (
                                <TableCell key={key} className="text-muted-foreground whitespace-nowrap max-w-[140px] truncate" title={player.source || ''}>
                                  {player.source || '—'}
                                </TableCell>
                              );
                            case 'birthDate':
                              return (
                                <TableCell key={key} className="text-muted-foreground whitespace-nowrap">
                                  {player.birth_date ? format(new Date(player.birth_date), 'dd-MM-yyyy') : '—'}
                                </TableCell>
                              );
                            case 'tags':
                              return (
                                <TableCell key={key} className="max-w-[240px] min-w-[140px] overflow-hidden">
                                  {activeAcademy && (
                                    <PlayerTagsCell
                                      academyId={activeAcademy.id}
                                      playerKey={{ guest_player_id: player.guest_player_id || null, profile_id: player.profile_id || null }}
                                      tags={tags}
                                      selectedTagIds={player.tag_ids || []}
                                      onTagsChange={setTags}
                                      onSelectedTagIdsChange={() => handlePlayerDataChanged()}
                                    />
                                  )}
                                </TableCell>
                              );
                            case 'internalNotes':
                              return (
                                <TableCell key={key} className="max-w-[260px] min-w-[140px] overflow-hidden">
                                  {activeAcademy && (
                                    <PlayerNotesCell
                                      academyId={activeAcademy.id}
                                      playerKey={{ guest_player_id: player.guest_player_id || null, profile_id: player.profile_id || null }}
                                      notes={player.academy_notes || ''}
                                      onChanged={handlePlayerDataChanged}
                                    />
                                  )}
                                </TableCell>
                              );
                            default:
                              return null;
                          }
                        })}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
            </DataTableCard>
          )}

          {pageCount > 1 && (
            <Pagination>
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    href="#"
                    aria-disabled={page === 0}
                    className={page === 0 ? 'pointer-events-none opacity-50' : ''}
                    onClick={(e) => { e.preventDefault(); setPage((p) => Math.max(0, p - 1)); }}
                  />
                </PaginationItem>
                {Array.from({ length: pageCount }, (_, i) => i)
                  .filter((i) => i === 0 || i === pageCount - 1 || Math.abs(i - page) <= 2)
                  .map((i, idx, arr) => (
                    <PaginationItem key={i}>
                      {idx > 0 && arr[idx - 1] !== i - 1 ? (
                        <span className="px-2 text-muted-foreground">…</span>
                      ) : null}
                      <PaginationLink
                        href="#"
                        isActive={i === page}
                        onClick={(e) => { e.preventDefault(); setPage(i); }}
                      >
                        {i + 1}
                      </PaginationLink>
                    </PaginationItem>
                  ))}
                <PaginationItem>
                  <PaginationNext
                    href="#"
                    aria-disabled={page >= pageCount - 1}
                    className={page >= pageCount - 1 ? 'pointer-events-none opacity-50' : ''}
                    onClick={(e) => { e.preventDefault(); setPage((p) => Math.min(pageCount - 1, p + 1)); }}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          )}
        </TabsContent>

        {/* Create Tab */}
        <TabsContent value="create" className="mt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <UserPlus className="h-5 w-5" />
                  {tTrainer('players.addPlayer')}
                </CardTitle>
                <CardDescription>
                  {tTrainer('players.addPlayerDescription', 'Add a new player to your academy.')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <AddPlayerForm
                  academyId={activeAcademy?.id}
                  onPlayerCreated={() => handlePlayerDataChanged()}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Upload className="h-5 w-5" />
                  {tTrainer('players.import.button', 'Import Players')}
                </CardTitle>
                <CardDescription>
                  {tTrainer('players.import.description', 'Import multiple players at once from a CSV file.')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="outline" onClick={() => setShowImportPlayers(true)}>
                  <Upload className="mr-2 h-4 w-4" />
                  {tTrainer('players.import.button', 'Import CSV')}
                </Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Email Campaign Tab */}
        <TabsContent value="email-campaign" className="mt-4">
          {activeAcademy && (
            <Suspense
              fallback={
                <div className="space-y-4">
                  <Skeleton className="h-10 w-64" />
                  <Skeleton className="h-[400px] w-full" />
                </div>
              }
            >
              <EmailCampaignTab
                academyId={activeAcademy.id}
                trainers={trainers}
                locations={allLocations}
                tags={tags}
                players={campaignPlayers.map((row) => ({
                  id: row.guest_player_id ?? `reg-${row.profile_id}`,
                  full_name: row.full_name,
                  email: row.email,
                  phone: row.phone,
                  billing_business_name: row.billing_business_name,
                  skill_rating: row.skill_rating,
                  trainer_id: row.owner_trainer_id ?? undefined,
                  trainer_ids: row.trainer_ids ?? [],
                  location_names: row.location_names ?? [],
                  has_active_cyclus: row.has_active_cyclus,
                  type: row.player_type as 'guest' | 'registered',
                  tag_ids: row.tag_ids ?? [],
                }))}
              />
            </Suspense>
          )}
        </TabsContent>
      </Tabs>

      {/* Add Player Dialog */}
      <AddPlayerDialog
        open={showAddPlayer}
        onOpenChange={setShowAddPlayer}
        academyId={activeAcademy?.id}
        trainerId={selectedTrainerId && selectedTrainerId !== 'all' ? selectedTrainerId : undefined}
        onPlayerCreated={handlePlayerCreated}
      />

      {/* Import Players Dialog */}
      <ImportPlayersDialog
        open={showImportPlayers}
        onOpenChange={setShowImportPlayers}
        academyId={activeAcademy?.id}
        trainerId={selectedTrainerId && selectedTrainerId !== 'all' ? selectedTrainerId : undefined}
        onPlayersImported={handlePlayersImported}
      />

      {/* Manage Tags Dialog */}
      {activeAcademy && (
        <ManagePlayerTagsDialog
          open={showManageTags}
          onOpenChange={setShowManageTags}
          academyId={activeAcademy.id}
          tags={tags}
          onChanged={handlePlayerDataChanged}
        />
      )}
    </AppPage>
  );
}
