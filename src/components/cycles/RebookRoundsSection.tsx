import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Archive, ArchiveRestore, Loader2, RefreshCw } from 'lucide-react';
import { formatDate } from '@/lib/format';
import { formatPrice } from '@/lib/pricing';
import { setRebookRoundArchived } from '@/lib/rebookManage';
import { listRebookRoundOverview, type RebookRoundOverviewRow } from '@/lib/rebookRoundsOverview';
import { getAcademyLocationsWithDetails } from '@/lib/academy';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { logger } from '@/lib/logger';
import { DataTable, type ColumnDef } from '@/components/ui/data-table-generic';
import { useTableSort } from '@/hooks/useTableSort';
import { useVisibleColumns, type ColumnDescriptor } from '@/components/players/useVisibleColumns';
import { PlayerColumnsMenu } from '@/components/players/PlayerColumnsMenu';
import { TableToolbar } from '@/components/ui/table-toolbar';
import { ListPagination } from '@/components/ui/list-pagination';

/**
 * The rebook management HUB — one row per rebooking round, sortable + searchable, reusing the shared
 * DataTable engine (same as Players/Invoices). Each row shows that round's response funnel + money at a
 * glance (aggregates via listRebookRoundOverview, matching the per-round drill-in); click a row to open
 * the full per-player manage view. Finished rounds can be archived (hidden without touching bookings).
 */

type ColKey =
  | 'start'
  | 'location'
  | 'series'
  | 'status'
  | 'invited'
  | 'rebooked'
  | 'noResponse'
  | 'paidAmount'
  | 'outstanding'
  | 'declined'
  | 'clickedYes'
  | 'paidCount'
  | 'invites'
  | 'openSpots';

const DEFAULT_COLUMNS: ColKey[] = [
  'start',
  'location',
  'series',
  'status',
  'invited',
  'rebooked',
  'noResponse',
  'paidAmount',
  'outstanding',
];

const PAGE_SIZE = 25;

export default function RebookRoundsSection({ academyId }: { academyId: string }) {
  const { t } = useTranslation('cycles');
  const navigate = useNavigate();
  const [rows, setRows] = useState<RebookRoundOverviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  // Location names for the Locatie column (id → name); best-effort, ids render as '—' until loaded.
  const [locationNameById, setLocationNameById] = useState<Map<string, string>>(new Map());

  const reload = useCallback(() => {
    let active = true;
    setLoading(true);
    listRebookRoundOverview(academyId, { includeArchived: true })
      .then((r) => { if (active) setRows(r); })
      .catch((e) => logger.error('Failed to load rebook rounds', e as Error, { component: 'RebookRoundsSection' }))
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [academyId]);

  useEffect(() => reload(), [reload]);

  useEffect(() => {
    let active = true;
    getAcademyLocationsWithDetails(academyId)
      .then((rows) => {
        if (!active) return;
        setLocationNameById(new Map(rows.filter((r) => r.location).map((r) => [r.location.id, r.location.name])));
      })
      .catch((e) => logger.error('Failed to load locations for rebook overview', e as Error, { component: 'RebookRoundsSection' }));
    return () => { active = false; };
  }, [academyId]);

  const setArchived = async (id: string, archived: boolean) => {
    setBusyId(id);
    try {
      await setRebookRoundArchived(id, archived);
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, archived } : r)));
      toast.success(archived
        ? t('rebookManage.roundArchived', 'Herboeking gearchiveerd')
        : t('rebookManage.roundRestored', 'Herboeking hersteld'));
    } catch (e) {
      toast.error(getFriendlyErrorMessage(e, t('rebookManage.roundArchiveFailed', 'Kon de herboeking niet bijwerken. Probeer het opnieuw.')));
    } finally { setBusyId(null); }
  };

  const archivedCount = useMemo(() => rows.filter((r) => r.archived).length, [rows]);

  // Rows enriched with the resolved location label (joined names) so the Locatie column can
  // sort and search on a plain string like every other column.
  type OverviewRow = RebookRoundOverviewRow & { locationLabel: string };
  const enriched: OverviewRow[] = useMemo(
    () => rows.map((r) => ({
      ...r,
      locationLabel: r.locationIds.map((id) => locationNameById.get(id) ?? '').filter(Boolean).join(', '),
    })),
    [rows, locationNameById],
  );

  // Archived visibility + name/location search (case-insensitive). Sorting is applied after, by the shared hook.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return enriched.filter((r) => {
      if (r.archived && !showArchived) return false;
      if (q && !(r.name || '').toLowerCase().includes(q) && !r.locationLabel.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [enriched, showArchived, search]);

  const { sortedData, sortConfig, handleSort } = useTableSort<OverviewRow>(filtered, undefined, null, { emptyLast: true });

  // Reset to the first page whenever the visible set changes.
  useEffect(() => { setPage(0); }, [search, showArchived, sortConfig.key, sortConfig.direction]);
  const pageCount = Math.max(1, Math.ceil(sortedData.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = sortedData.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const { visibleColumns, toggleColumn, isColVisible } = useVisibleColumns<ColKey>(
    columnDescriptors(t),
    DEFAULT_COLUMNS,
    academyId ? `rebookManage:overview:cols:v2:${academyId}` : null,
  );

  const num = (r: RebookRoundOverviewRow, v: number) => (r.statsLoaded ? v : '—');

  const cycleStatusLabel = (s: string) =>
    t(`rebookManage.overview.cycleStatus.${s}`, s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
  const statusVariant = (s: string): 'default' | 'secondary' | 'outline' =>
    s === 'open' ? 'default' : s === 'closed' ? 'outline' : 'secondary';

  const columns: ColumnDef<OverviewRow>[] = [
    {
      key: 'name',
      header: t('rebookManage.overview.colRound', 'Ronde'),
      sortKey: 'name',
      className: 'font-medium max-w-[240px]',
      cellTitle: (r) => r.name || undefined,
      linkTo: (r) => `/app/academy/cycles/${r.id}/rebook`,
      renderCell: (r) => (
        <span className="flex items-center gap-2">
          <span className="truncate">{r.name || t('rebookManage.untitledRound', 'Herboeking')}</span>
          {r.archived && (
            <Badge variant="outline" className="shrink-0 text-[10px]">{t('rebookManage.overview.archivedTag', 'Gearchiveerd')}</Badge>
          )}
        </span>
      ),
    },
    {
      key: 'start',
      header: t('rebookManage.overview.colStart', 'Start'),
      sortKey: 'startDate',
      // start_date is a pure DATE — parse at local noon so it never shifts a day.
      renderCell: (r) => (r.startDate ? formatDate(`${r.startDate}T12:00:00`, 'd MMM yyyy') : '—'),
    },
    {
      key: 'location',
      header: t('rebookManage.overview.colLocation', 'Locatie'),
      sortKey: 'locationLabel',
      className: 'max-w-[200px]',
      cellTitle: (r) => r.locationLabel || undefined,
      renderCell: (r) => <span className="truncate">{r.locationLabel || '\u2014'}</span>,
    },
    { key: 'series', header: t('rebookManage.overview.colSeries', 'Series'), sortKey: 'seriesCount', align: 'right', renderCell: (r) => r.seriesCount },
    {
      key: 'status',
      header: t('rebookManage.overview.colStatus', 'Status'),
      sortKey: 'status',
      renderCell: (r) => <Badge variant={statusVariant(r.status)}>{cycleStatusLabel(r.status)}</Badge>,
    },
    { key: 'invited', header: t('rebookManage.overview.colInvited', 'Uitgenodigd'), sortKey: 'invited', align: 'right', renderCell: (r) => num(r, r.invited) },
    { key: 'rebooked', header: t('rebookManage.overview.colRebooked', 'Herboekt'), sortKey: 'rebooked', align: 'right', renderCell: (r) => num(r, r.rebooked) },
    { key: 'noResponse', header: t('rebookManage.overview.colNoResponse', 'Geen reactie'), sortKey: 'noResponse', align: 'right', renderCell: (r) => num(r, r.noResponse) },
    { key: 'paidAmount', header: t('rebookManage.overview.colPaidAmount', 'Betaald'), sortKey: 'paidAmount', align: 'right', renderCell: (r) => (r.statsLoaded ? formatPrice(r.paidAmount) : '—') },
    { key: 'outstanding', header: t('rebookManage.overview.colOutstanding', 'Openstaand'), sortKey: 'outstandingAmount', align: 'right', renderCell: (r) => (r.statsLoaded ? formatPrice(r.outstandingAmount) : '—') },
    { key: 'declined', header: t('rebookManage.overview.colDeclined', 'Zei nee'), sortKey: 'declined', align: 'right', renderCell: (r) => num(r, r.declined) },
    { key: 'clickedYes', header: t('rebookManage.overview.colClickedYes', 'Ja, niet afgerond'), sortKey: 'clickedYesUnpaid', align: 'right', renderCell: (r) => num(r, r.clickedYesUnpaid) },
    { key: 'paidCount', header: t('rebookManage.overview.colPaidCount', 'Betaald (spelers)'), sortKey: 'paidCount', align: 'right', renderCell: (r) => num(r, r.paidCount) },
    { key: 'invites', header: t('rebookManage.overview.colInvites', 'Uitnodigingen'), sortKey: 'invitesSent', align: 'right', renderCell: (r) => (r.statsLoaded ? `${r.invitesSent}/${r.invitesTotal}` : '—') },
    { key: 'openSpots', header: t('rebookManage.overview.colOpenSpots', 'Open plekken'), sortKey: 'openSpots', align: 'right', renderCell: (r) => num(r, r.openSpots) },
  ];

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center">
        <RefreshCw className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
        <p className="font-medium">{t('rebookManage.overview.emptyTitle', 'Nog geen herboekingen')}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('rebookManage.overview.emptyDescription', 'Zet een volgende ronde op via de Sessies-hub om spelers te laten herboeken.')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <TableToolbar
        searchPlaceholder={t('rebookManage.overview.searchPlaceholder', 'Zoek op naam of locatie…')}
        searchValue={search}
        onSearchChange={setSearch}
        trailing={
          <PlayerColumnsMenu<ColKey>
            allColumns={columnDescriptors(t)}
            isColVisible={isColVisible}
            onToggle={toggleColumn}
            labels={{
              button: t('rebookManage.overview.columnsButton', 'Kolommen'),
              default: t('rebookManage.overview.columnsDefault', 'Standaard'),
              optional: t('rebookManage.overview.columnsOptional', 'Optioneel'),
            }}
          />
        }
      >
        {archivedCount > 0 && (
          <Button variant="outline" size="sm" onClick={() => setShowArchived((v) => !v)}>
            {showArchived
              ? t('rebookManage.hideArchived', 'Verberg gearchiveerd')
              : t('rebookManage.showArchived', 'Toon gearchiveerd ({{count}})', { count: archivedCount })}
          </Button>
        )}
      </TableToolbar>

      <DataTable<OverviewRow>
        columns={columns}
        rows={pageRows}
        visibleKeys={['name', ...visibleColumns]}
        sortKey={sortConfig.key ? String(sortConfig.key) : null}
        sortDirection={sortConfig.direction}
        onSort={(key) => handleSort(key as keyof OverviewRow)}
        onRowClick={(r) => navigate(`/app/academy/cycles/${r.id}/rebook`)}
        compact
        stickyHeader
        // Show on mobile too (horizontal-scrolls via compact min-width) — the old card list rendered
        // on phones, and the sibling admin tables (CyclesTable/WaitingListTable/InvoiceListTable) do the same.
        desktopOnly={false}
        actionsHeader={<span className="sr-only">{t('rebookManage.overview.actionsHeader', 'Acties')}</span>}
        renderActions={(r) => (
          <Button
            size="sm"
            variant="ghost"
            disabled={busyId === r.id}
            onClick={() => setArchived(r.id, !r.archived)}
            title={r.archived ? t('rebookManage.restoreRound', 'Herstellen') : t('rebookManage.archiveRound', 'Archiveren')}
            aria-label={r.archived ? t('rebookManage.restoreRound', 'Herstellen') : t('rebookManage.archiveRound', 'Archiveren')}
          >
            {busyId === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : r.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
          </Button>
        )}
        empty={t('rebookManage.overview.noMatches', 'Geen herboekingen gevonden.')}
      />

      <ListPagination page={safePage} pageCount={pageCount} onPageChange={setPage} />
    </div>
  );
}

function columnDescriptors(t: (key: string, fallback: string) => string): ColumnDescriptor<ColKey>[] {
  return [
    { key: 'start', label: t('rebookManage.overview.colStart', 'Start'), isDefault: true },
    { key: 'location', label: t('rebookManage.overview.colLocation', 'Locatie'), isDefault: true },
    { key: 'series', label: t('rebookManage.overview.colSeries', 'Series'), isDefault: true },
    { key: 'status', label: t('rebookManage.overview.colStatus', 'Status'), isDefault: true },
    { key: 'invited', label: t('rebookManage.overview.colInvited', 'Uitgenodigd'), isDefault: true },
    { key: 'rebooked', label: t('rebookManage.overview.colRebooked', 'Herboekt'), isDefault: true },
    { key: 'noResponse', label: t('rebookManage.overview.colNoResponse', 'Geen reactie'), isDefault: true },
    { key: 'paidAmount', label: t('rebookManage.overview.colPaidAmount', 'Betaald'), isDefault: true },
    { key: 'outstanding', label: t('rebookManage.overview.colOutstanding', 'Openstaand'), isDefault: true },
    { key: 'declined', label: t('rebookManage.overview.colDeclined', 'Zei nee'), isDefault: false },
    { key: 'clickedYes', label: t('rebookManage.overview.colClickedYes', 'Ja, niet afgerond'), isDefault: false },
    { key: 'paidCount', label: t('rebookManage.overview.colPaidCount', 'Betaald (spelers)'), isDefault: false },
    { key: 'invites', label: t('rebookManage.overview.colInvites', 'Uitnodigingen'), isDefault: false },
    { key: 'openSpots', label: t('rebookManage.overview.colOpenSpots', 'Open plekken'), isDefault: false },
  ];
}
