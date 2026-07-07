import { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { Users, UserPlus, Upload, Mail, RefreshCw, Tags } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmailBounceBadge } from '@/components/email/EmailBounceBadge';
import { Button } from '@/components/ui/button';
import { SelectFilter } from '@/components/ui/select-filter';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTable, type ColumnDef } from '@/components/ui/data-table-generic';
import { useAuth } from '@/hooks/useAuth';
import { useTrainerCanEdit } from '@/hooks/useTrainerHasAcademy';
import { supabase } from '@/lib/supabaseClient';
import {
  usePlayersOverview,
  fetchPlayersOverview,
  fetchAllPlayersOverview,
  mapPlayersOverviewRow,
  type UnifiedPlayer,
  type PlayersOverviewFilters,
  type LevelBand,
} from '@/lib/playersOverview';
import { playerKeys, invalidateAllPlayerData } from '@/lib/playerQueryKeys';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { format } from 'date-fns';
import { ListPagination } from '@/components/ui/list-pagination';
import { useVisibleColumns } from '@/components/players/useVisibleColumns';
import { PlayerColumnsMenu } from '@/components/players/PlayerColumnsMenu';
import { AddPlayerDialog } from '@/components/players/AddPlayerDialog';
import { AddPlayerForm } from '@/components/players/AddPlayerForm';
import { ImportPlayersDialog } from '@/components/players/ImportPlayersDialog';
import { TrainerPageHeader } from '@/components/trainer/shell/TrainerPageHeader';
import { EmptyState } from '@/components/ui/empty-state';
import { AppPage } from '@/components/ui/app-page';
import { flushOnMobileCardClass } from '@/components/ui/surface';
import { TableToolbar } from '@/components/ui/table-toolbar';
import { ListPageSkeleton } from '@/components/ui/list-page-skeleton';
import { Skeleton } from '@/components/ui/skeleton';
import { PlayerTagsCell } from '@/components/players/PlayerTagsCell';
import { PlayerNotesCell } from '@/components/players/PlayerNotesCell';
import { ManagePlayerTagsDialog } from '@/components/players/ManagePlayerTagsDialog';
import { PlayerTag, getTagColorClass } from '@/components/players/playerTagColors';
import { cn } from '@/lib/utils';
import { toTrainerPlayerRouteId } from '@/lib/invoiceCustomer';

// Lazy: pulls in the heavy TipTap editor chunk — only load when the tab is opened
const EmailCampaignTab = lazy(() =>
  import('@/components/players/EmailCampaignTab').then((m) => ({ default: m.EmailCampaignTab }))
);


function getLevelLabel(band: string): string {
  switch (band) {
    case 'beginner': return 'Beginner (1-3)';
    case 'intermediate': return 'Intermediate (4-6)';
    case 'advanced': return 'Advanced (7-9)';
    case 'pro': return 'Pro (9+)';
    case 'unrated': return 'Unrated';
    default: return band;
  }
}

export default function TrainerPlayers() {
  const { t } = useTranslation('trainer');
  const { user } = useAuth();
  const { canEdit } = useTrainerCanEdit();
  const [searchParams, setSearchParams] = useSearchParams();

  const activeTab = searchParams.get('tab') || 'all-players';
  const setActiveTab = (tab: string) => setSearchParams({ tab });

  const queryClient = useQueryClient();
  const [trainerId, setTrainerId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearch = useDebouncedValue(searchQuery);

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
    | 'skill' | 'status' | 'cyclus' | 'type' | 'notes' | 'source' | 'birthDate' | 'tags' | 'internalNotes';
  const DEFAULT_COLUMNS: ColumnKey[] = ['tags', 'internalNotes', 'email', 'phone', 'location', 'addedOn'];
  const ALL_COLUMNS: { key: ColumnKey; label: string; isDefault: boolean }[] = [
    { key: 'tags', label: t('players.columns.tags', 'Tags'), isDefault: true },
    { key: 'internalNotes', label: t('players.columns.internalNotes', 'Internal notes'), isDefault: true },
    { key: 'email', label: t('players.columns.email', 'Email'), isDefault: true },
    { key: 'phone', label: t('players.columns.phone', 'Phone'), isDefault: true },
    { key: 'location', label: t('players.columns.location', 'Location'), isDefault: true },
    { key: 'addedOn', label: t('players.columns.addedOn', 'Date added'), isDefault: true },
    { key: 'skill', label: t('players.columns.skill', 'Skill rating'), isDefault: false },
    { key: 'status', label: t('players.columns.status', 'Status'), isDefault: false },
    { key: 'cyclus', label: t('players.columns.cyclus', 'In active cyclus'), isDefault: false },
    { key: 'type', label: t('players.columns.type', 'Type'), isDefault: false },
    { key: 'notes', label: t('players.columns.notes', 'Notes (intake)'), isDefault: false },
    { key: 'source', label: t('players.columns.source', 'Source'), isDefault: false },
    { key: 'birthDate', label: t('players.columns.birthDate', 'Birth date'), isDefault: false },
  ];
  const storageKey = trainerId ? `trainerPlayers:visibleColumns:${trainerId}` : null;
  const { visibleColumns, toggleColumn, isColVisible } = useVisibleColumns(ALL_COLUMNS, DEFAULT_COLUMNS, storageKey);

  // Resolve trainerId
  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await supabase
        .from('trainer_profiles')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle();
      if (data) setTrainerId(data.id);
    })();
  }, [user]);

  // Fetch tags and locations (filter dropdowns)
  useEffect(() => {
    if (!trainerId) return;
    fetchTags();
    fetchLocations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trainerId]);

  const fetchTags = async () => {
    if (!trainerId) return;
    const { data } = await supabase
      .from('academy_player_tags')
      .select('*')
      .eq('trainer_profile_id', trainerId)
      .order('name');
    setTags((data || []) as PlayerTag[]);
  };

  // Locations dropdown options: the trainer's own slot locations plus guests'
  // preferred locations — the same sources the old client pipeline surfaced.
  const fetchLocations = async () => {
    if (!trainerId) return;
    const [slotsRes, guestsRes] = await Promise.all([
      supabase
        .from('availability_slots')
        .select('location_id')
        .eq('trainer_id', trainerId)
        .not('location_id', 'is', null),
      supabase
        .from('guest_players')
        .select('preferred_location_id')
        .eq('trainer_id', trainerId)
        .not('preferred_location_id', 'is', null),
    ]);
    const locIds = new Set<string>();
    slotsRes.data?.forEach((s) => { if (s.location_id) locIds.add(s.location_id); });
    guestsRes.data?.forEach((g) => { if (g.preferred_location_id) locIds.add(g.preferred_location_id); });
    if (locIds.size === 0) {
      setAllLocations([]);
      return;
    }
    const { data: locs } = await supabase
      .from('locations')
      .select('id, name')
      .in('id', Array.from(locIds));
    setAllLocations((locs || []).sort((a, b) => a.name.localeCompare(b.name)));
  };

  // Tag/notes edits refresh every player view through the central subtree.
  const handlePlayerDataChanged = () => {
    if (trainerId) invalidateAllPlayerData(queryClient, { kind: 'trainer', id: trainerId });
  };

  // Server-side overview: search, filters, sort and pagination all happen in
  // the get_players_overview RPC — one round trip, exact totals, no 1000-row
  // truncation. Removal filtering (removed_at) is enforced in SQL.
  const overviewFilters: PlayersOverviewFilters = useMemo(() => ({
    locationId: selectedLocation !== 'all' ? selectedLocation : null,
    levelBand: selectedLevel !== 'all' ? (selectedLevel as LevelBand) : null,
    hasActiveCyclus: selectedCyclus === 'yes' ? true : selectedCyclus === 'no' ? false : null,
    tagId: selectedTagId !== 'all' ? selectedTagId : null,
    payment: selectedPaymentStatus !== 'all' ? (selectedPaymentStatus as 'overdue' | 'ok') : null,
  }), [selectedLocation, selectedLevel, selectedCyclus, selectedTagId, selectedPaymentStatus]);

  // Snap back to the first page whenever the result set changes shape.
  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, overviewFilters]);

  const rpcSort = sortKey === 'addedOn' ? 'created_at' : sortKey;
  const { data: overview, isLoading: loading } = usePlayersOverview(
    { kind: 'trainer', id: trainerId },
    { search: debouncedSearch, filters: overviewFilters, sort: rpcSort, sortDir, page, pageSize: PAGE_SIZE },
  );
  const totalFiltered = overview?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalFiltered / PAGE_SIZE));

  const sortedPlayers: UnifiedPlayer[] = useMemo(
    () => (overview?.rows ?? []).map((row) => mapPlayersOverviewRow(row)),
    [overview],
  );

  // Header count: unfiltered active-player total (removal already applied by
  // the RPC), independent of the table's search/filters.
  const { data: activePlayerCount = 0 } = useQuery({
    queryKey: playerKeys.count('trainer', trainerId),
    queryFn: async () => {
      const { total } = await fetchPlayersOverview(
        { kind: 'trainer', id: trainerId! },
        { pageSize: 1 },
      );
      return total;
    },
    enabled: !!trainerId,
  });

  // Email campaign needs the COMPLETE player list (recipient selection) —
  // fetched via deterministic page-through, so no silent 1000-row cap.
  const { data: campaignPlayers = [] } = useQuery({
    queryKey: playerKeys.campaignAll('trainer', trainerId),
    queryFn: () => fetchAllPlayersOverview({ kind: 'trainer', id: trainerId! }),
    enabled: !!trainerId && activeTab === 'email-campaign',
  });

  const handlePlayerCreated = () => { handlePlayerDataChanged(); setShowAddPlayer(false); };
  const handlePlayersImported = () => { handlePlayerDataChanged(); };

  if (loading) {
    return (
      <AppPage>
        <ListPageSkeleton />
      </AppPage>
    );
  }

  // Player table columns. The `name` column is always shown (first); the rest are toggled via
  // `visibleColumns` (passed as the engine's `visibleKeys`, which also drives their order). The name
  // cell keeps its own <Link> (so right/middle/Cmd-click already opens a new tab) — hence no engine
  // `linkTo` here, which would nest anchors.
  const columns: ColumnDef<UnifiedPlayer>[] = [
    {
      key: 'name',
      header: t('players.name'),
      sortKey: 'name',
      headClassName: 'whitespace-nowrap',
      className: 'font-medium whitespace-nowrap max-w-[260px] min-w-0 overflow-hidden',
      cellTitle: (player) => player.full_name,
      renderCell: (player) => (
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          <Link
            to={`/app/trainer/players/${toTrainerPlayerRouteId(player)}`}
            className="hover:underline text-foreground truncate"
          >
            {player.full_name}
          </Link>
          {player.has_overdue_payment && (
            <Badge variant="destructive" className="h-5 px-1.5 text-[11px] shrink-0">
              {t('players.payment.overdue', 'Overdue')}
            </Badge>
          )}
          {player.email_undeliverable && <EmailBounceBadge compact />}
        </div>
      ),
    },
    {
      key: 'email',
      header: t('players.columns.email', 'Email'),
      sortKey: 'email',
      headClassName: 'whitespace-nowrap',
      className: 'whitespace-nowrap max-w-[220px] min-w-0 overflow-hidden truncate',
      cellTitle: (player) => player.email || '',
      renderCell: (player) => player.email || <span className="text-muted-foreground">—</span>,
    },
    {
      key: 'phone',
      header: t('players.columns.phone', 'Phone'),
      headClassName: 'whitespace-nowrap',
      className: 'whitespace-nowrap overflow-hidden',
      renderCell: (player) => player.phone || <span className="text-muted-foreground">—</span>,
    },
    {
      key: 'location',
      header: t('players.columns.location', 'Location'),
      headClassName: 'whitespace-nowrap',
      className: 'text-muted-foreground whitespace-nowrap max-w-[180px] min-w-0 overflow-hidden truncate',
      cellTitle: (player) => player.location_names?.join(', ') || '',
      renderCell: (player) =>
        player.location_names && player.location_names.length > 0 ? player.location_names.join(', ') : '—',
    },
    {
      key: 'addedOn',
      header: t('players.columns.addedOn', 'Date added'),
      sortKey: 'addedOn',
      headClassName: 'whitespace-nowrap',
      className: 'text-muted-foreground whitespace-nowrap',
      renderCell: (player) => format(new Date(player.created_at), 'dd-MM-yyyy'),
    },
    {
      key: 'skill',
      header: t('players.columns.skill', 'Skill rating'),
      sortKey: 'skill',
      headClassName: 'whitespace-nowrap',
      className: 'whitespace-nowrap',
      renderCell: (player) =>
        player.skill_rating ? (
          <span className="inline-flex items-center gap-1">
            <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">{player.skill_rating.toFixed(1)}</Badge>
            <span className="text-[11px] text-muted-foreground uppercase">{player.rating_system || 'knltb'}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'status',
      header: t('players.columns.status', 'Status'),
      headClassName: 'whitespace-nowrap',
      className: 'whitespace-nowrap',
      renderCell: (player) =>
        player.type === 'registered' ? (
          <Badge variant="default" className="h-5 px-1.5 text-[11px]">{t('players.statuses.registered')}</Badge>
        ) : player.has_trained ? (
          <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">{t('players.statuses.active')}</Badge>
        ) : (
          <Badge variant="outline" className="h-5 px-1.5 text-[11px]">{t('players.statuses.prospect')}</Badge>
        ),
    },
    {
      key: 'cyclus',
      header: t('players.columns.cyclus', 'In active cyclus'),
      headClassName: 'whitespace-nowrap',
      className: 'whitespace-nowrap',
      renderCell: (player) =>
        player.has_active_cyclus ? (
          <Badge variant="outline" className="h-5 px-1.5 text-[11px] border-primary/30 text-primary">
            <RefreshCw className="h-2.5 w-2.5 mr-1" />
            {t('players.columns.cyclusYes', 'Yes')}
          </Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'type',
      header: t('players.columns.type', 'Type'),
      headClassName: 'whitespace-nowrap',
      className: 'whitespace-nowrap',
      renderCell: (player) => (
        <Badge variant="outline" className="h-5 px-1.5 text-[11px]">
          {player.type === 'guest'
            ? t('players.columns.typeGuest', 'Guest')
            : t('players.columns.typeRegistered', 'Registered')}
        </Badge>
      ),
    },
    {
      key: 'notes',
      header: t('players.columns.notes', 'Notes (intake)'),
      headClassName: 'whitespace-nowrap',
      className: 'text-muted-foreground max-w-[220px]',
      renderCell: (player) => <div className="truncate" title={player.notes || ''}>{player.notes || '—'}</div>,
    },
    {
      key: 'source',
      header: t('players.columns.source', 'Source'),
      headClassName: 'whitespace-nowrap',
      className: 'text-muted-foreground whitespace-nowrap max-w-[140px] truncate',
      cellTitle: (player) => player.source || '',
      renderCell: (player) => player.source || '—',
    },
    {
      key: 'birthDate',
      header: t('players.columns.birthDate', 'Birth date'),
      headClassName: 'whitespace-nowrap',
      className: 'text-muted-foreground whitespace-nowrap',
      renderCell: (player) => (player.birth_date ? format(new Date(player.birth_date), 'dd-MM-yyyy') : '—'),
    },
    {
      key: 'tags',
      header: t('players.columns.tags', 'Tags'),
      headClassName: 'whitespace-nowrap',
      className: 'max-w-[240px] min-w-[140px] overflow-hidden',
      renderCell: (player) =>
        trainerId ? (
          <PlayerTagsCell
            trainerId={trainerId}
            playerKey={{ guest_player_id: player.guest_player_id || null, profile_id: player.profile_id || null }}
            tags={tags}
            selectedTagIds={player.tag_ids || []}
            onTagsChange={setTags}
            onSelectedTagIdsChange={() => handlePlayerDataChanged()}
            readOnly={!canEdit}
          />
        ) : null,
    },
    {
      key: 'internalNotes',
      header: t('players.columns.internalNotes', 'Internal notes'),
      headClassName: 'whitespace-nowrap',
      className: 'max-w-[260px] min-w-[140px] overflow-hidden',
      renderCell: (player) =>
        trainerId ? (
          <PlayerNotesCell
            trainerId={trainerId}
            playerKey={{ guest_player_id: player.guest_player_id || null, profile_id: player.profile_id || null }}
            notes={player.internal_notes || ''}
            onChanged={handlePlayerDataChanged}
            readOnly={!canEdit}
          />
        ) : null,
    },
  ];

  return (
    <AppPage className="space-y-5">
      <TrainerPageHeader
        title={t('players.title')}
        description={t('players.subtitleShort', 'Manage your players and contacts')}
        countText={`${activePlayerCount} ${activePlayerCount === 1 ? t('players.playerSingular', 'player') : t('players.playerPlural', 'players')}`}
        // View-only academy trainers get no add/import/manage actions.
        primaryAction={canEdit ? {
          label: t('players.addPlayer'),
          onClick: () => setShowAddPlayer(true),
          icon: UserPlus,
        } : undefined}
        moreMenuItems={canEdit ? [
          {
            label: t('players.import.button'),
            onClick: () => setShowImportPlayers(true),
            icon: Upload,
          },
          {
            label: t('players.tags.manageButton', 'Manage tags'),
            onClick: () => setShowManageTags(true),
            icon: Tags,
          },
        ] : undefined}
      />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="all-players" className="gap-2">
            <Users className="h-4 w-4" />
            <span className="hidden sm:inline">{t('players.allPlayers', 'All Players')}</span>
          </TabsTrigger>
          {canEdit && (
            <TabsTrigger value="create" className="gap-2">
              <UserPlus className="h-4 w-4" />
              <span className="hidden sm:inline">{t('players.create', 'Create')}</span>
            </TabsTrigger>
          )}
          {canEdit && (
          <TabsTrigger value="email-campaign" className="gap-2">
            <Mail className="h-4 w-4" />
            <span className="hidden sm:inline">{t('players.emailCampaign', 'Email Campaign')}</span>
          </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="all-players" className="space-y-3 mt-3">
          <TableToolbar
            searchPlaceholder={t('players.searchPlayers')}
            searchValue={searchQuery}
            onSearchChange={setSearchQuery}
            trailing={
              <PlayerColumnsMenu
                allColumns={ALL_COLUMNS}
                isColVisible={isColVisible}
                onToggle={toggleColumn}
                labels={{
                  button: t('players.columns.button', 'Columns'),
                  default: t('players.columns.default', 'Default'),
                  optional: t('players.columns.optional', 'Optional'),
                }}
              />
            }
          >
            {allLocations.length > 0 && (
              <SelectFilter
                value={selectedLocation}
                onValueChange={setSelectedLocation}
                allLabel={t('players.allLocations', 'All Locations')}
                options={allLocations.map((loc) => ({ value: loc.id, label: loc.name }))}
                triggerClassName="w-full sm:w-[160px]"
              />
            )}

            <SelectFilter
              value={selectedLevel}
              onValueChange={setSelectedLevel}
              allLabel={t('players.allLevels', 'All Levels')}
              options={[
                { value: 'beginner', label: getLevelLabel('beginner') },
                { value: 'intermediate', label: getLevelLabel('intermediate') },
                { value: 'advanced', label: getLevelLabel('advanced') },
                { value: 'pro', label: getLevelLabel('pro') },
                { value: 'unrated', label: getLevelLabel('unrated') },
              ]}
              triggerClassName="w-full sm:w-[170px]"
            />

            <SelectFilter
              value={selectedCyclus}
              onValueChange={setSelectedCyclus}
              allLabel={t('players.allCyclus', 'All')}
              options={[
                { value: 'yes', label: t('players.hasCyclus', 'Has Cyclus') },
                { value: 'no', label: t('players.noCyclus', 'No Cyclus') },
              ]}
              triggerClassName="w-full sm:w-[160px]"
              placeholder={t('players.activeCyclus', 'Active Cyclus')}
            />

            <SelectFilter
              value={selectedTagId}
              onValueChange={setSelectedTagId}
              allLabel={t('players.tags.filterAll', 'All Tags')}
              options={[
                { value: 'untagged', label: t('players.tags.untagged', 'Untagged') },
                ...tags.map((tag) => ({
                  value: tag.id,
                  label: (
                    <>
                      <span className={cn('inline-block h-2 w-2 rounded-full mr-2', getTagColorClass(tag.color).split(' ').filter(c => c.startsWith('bg-')).join(' '))} />
                      {tag.name}
                    </>
                  ),
                })),
              ]}
              triggerClassName="w-full sm:w-[160px]"
            />

            <SelectFilter
              value={selectedPaymentStatus}
              onValueChange={setSelectedPaymentStatus}
              allLabel={t('players.payment.filterAll', 'All payments')}
              options={[
                { value: 'overdue', label: t('players.payment.overdue', 'Overdue') },
                { value: 'ok', label: t('players.payment.ok', 'No overdue') },
              ]}
              triggerClassName="w-full sm:w-[170px]"
              placeholder={t('players.payment.filterAll', 'Payment status')}
            />
          </TableToolbar>

          {sortedPlayers.length === 0 ? (
            <Card className="overflow-hidden border-border/80 shadow-sm">
              <EmptyState variant="trainer"
                icon={Users}
                title={searchQuery ? t('players.noPlayersFound') : t('players.empty', 'No players yet')}
                description={searchQuery ? t('players.tryDifferentSearch') : t('players.emptyDescription', 'Players will appear here once they book with you.')}
              />
              {!searchQuery && canEdit && (
                <div className="flex justify-center border-t border-border/60 px-4 pb-8 pt-2">
                  <Button
                    className="bg-[hsl(var(--brand-500))] hover:bg-[hsl(var(--brand-600))]"
                    onClick={() => setShowAddPlayer(true)}
                  >
                    <UserPlus className="mr-2 h-4 w-4" />
                    {t('players.addPlayer')}
                  </Button>
                </div>
              )}
            </Card>
          ) : (
            <DataTable<UnifiedPlayer>
              columns={columns}
              rows={sortedPlayers}
              visibleKeys={['name', ...visibleColumns]}
              sortKey={sortKey}
              sortDirection={sortDir}
              onSort={toggleSort}
              compact
              stickyHeader
              cardTestId="trainer-players-table-scroll"
              cardClassName={flushOnMobileCardClass()}
              mobile={
                <div className="md:hidden divide-y divide-border/60" data-testid="trainer-players-mobile-cards">
                  {sortedPlayers.map((player) => (
                    <div key={player.id} className="py-3 space-y-2 first:pt-1">
                      <div className="flex items-center justify-between">
                        <div className="min-w-0 flex-1">
                          <Link
                            to={`/app/trainer/players/${toTrainerPlayerRouteId(player)}`}
                            className="font-medium truncate hover:underline text-foreground block"
                            data-testid="trainer-player-mobile-detail-link"
                          >
                            {player.full_name}
                          </Link>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {player.type === 'registered' ? (
                            <Badge variant="default" className="text-xs">{t('players.statuses.registered')}</Badge>
                          ) : player.has_trained ? (
                            <Badge variant="secondary" className="text-xs">{t('players.statuses.active')}</Badge>
                          ) : (
                            <Badge variant="outline" className="text-xs">{t('players.statuses.prospect')}</Badge>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                        {player.email && <span>{player.email}</span>}
                        {player.phone && <span>{player.phone}</span>}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        {player.skill_rating && (
                          <Badge variant="secondary" className="text-xs">
                            {player.skill_rating.toFixed(1)} {player.rating_system?.toUpperCase()}
                          </Badge>
                        )}
                        {player.has_active_cyclus && (
                          <Badge variant="outline" className="text-xs border-primary/30 text-primary">
                            <RefreshCw className="h-3 w-3 mr-1" /> Cyclus
                          </Badge>
                        )}
                        <span>{format(new Date(player.created_at), 'MMM d, yyyy')}</span>
                      </div>
                    </div>
                  ))}
                </div>
              }
            />
          )}

          <ListPagination page={page} pageCount={pageCount} onPageChange={setPage} />
        </TabsContent>

        {/* Create Tab — view-only academy trainers can't create players */}
        {canEdit && (
        <TabsContent value="create" className="mt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <UserPlus className="h-5 w-5" />
                  {t('players.addPlayer')}
                </CardTitle>
                <CardDescription>
                  {t('players.addPlayerDescription', 'Add a new player to your roster.')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <AddPlayerForm
                  trainerId={trainerId || undefined}
                  onPlayerCreated={() => handlePlayerDataChanged()}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Upload className="h-5 w-5" />
                  {t('players.import.button', 'Import Players')}
                </CardTitle>
                <CardDescription>
                  {t('players.import.description', 'Import multiple players at once from a CSV file.')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="outline" onClick={() => setShowImportPlayers(true)}>
                  <Upload className="mr-2 h-4 w-4" />
                  {t('players.import.button', 'Import CSV')}
                </Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
        )}

        {/* Email Campaign Tab — outbound blast is not a view-only action */}
        {canEdit && (
        <TabsContent value="email-campaign" className="mt-4">
          {trainerId && (
            <Suspense
              fallback={
                <div className="space-y-4">
                  <Skeleton className="h-10 w-64" />
                  <Skeleton className="h-[400px] w-full" />
                </div>
              }
            >
              <EmailCampaignTab
                trainerId={trainerId}
                trainers={[]}
                locations={allLocations}
                tags={tags}
                players={campaignPlayers.map((row) => ({
                  id: row.guest_player_id ?? `reg-${row.profile_id}`,
                  full_name: row.full_name,
                  email: row.email,
                  phone: row.phone,
                  billing_business_name: row.billing_business_name,
                  skill_rating: row.skill_rating,
                  location_names: row.location_names ?? [],
                  has_active_cyclus: row.has_active_cyclus,
                  type: row.player_type as 'guest' | 'registered',
                  tag_ids: row.tag_ids ?? [],
                }))}
              />
            </Suspense>
          )}
        </TabsContent>
        )}
      </Tabs>

      {/* Add Player Dialog */}
      {trainerId && (
        <AddPlayerDialog
          open={showAddPlayer}
          onOpenChange={setShowAddPlayer}
          trainerId={trainerId}
          onPlayerCreated={handlePlayerCreated}
        />
      )}

      {/* Import Players Dialog */}
      {trainerId && (
        <ImportPlayersDialog
          open={showImportPlayers}
          onOpenChange={setShowImportPlayers}
          trainerId={trainerId}
          onPlayersImported={handlePlayersImported}
        />
      )}

      {/* Manage Tags Dialog */}
      {trainerId && (
        <ManagePlayerTagsDialog
          open={showManageTags}
          onOpenChange={setShowManageTags}
          trainerId={trainerId}
          tags={tags}
          onChanged={() => { fetchTags(); handlePlayerDataChanged(); }}
        />
      )}
    </AppPage>
  );
}
