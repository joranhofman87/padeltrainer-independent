import { useState, lazy, Suspense } from 'react';
import { CycleStatusBadge } from './CycleStatusBadge';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { format, differenceInWeeks } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { DataTable, type ColumnDef } from '@/components/ui/data-table-generic';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { SelectFilter } from '@/components/ui/select-filter';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  MoreHorizontal,
  Copy,
  Edit,
  Trash,
  ExternalLink,
  Users,
  ToggleLeft,
  ToggleRight,
  Search,
  QrCode,
} from 'lucide-react';
import { type Cycle, updateCycle } from '@/lib/cycles';
import { syncRegistrationStatus } from '@/lib/registrations';
import { buildRegistrationUrl } from '@/lib/cycleRegistrationUrl';
import DeleteCycleDialog from '@/components/cycles/DeleteCycleDialog';

const RegistrationQrDialog = lazy(() => import('@/components/cycles/RegistrationQrDialog'));
import { toast } from 'sonner';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { formatCurrency } from '@/lib/format';

interface CyclesTableProps {
  cycles: Cycle[];
  locations?: { id: string; name: string; city: string }[];
  onEdit: (cycle: Cycle) => void;
  /** Per-row destination for the name-cell <Link> (open-in-new-tab) — should match `onEdit`'s target. */
  rowHref?: (cycle: Cycle) => string;
  onDuplicate?: (cycle: Cycle) => void;
  onDeleted: () => void;
  ownerType: 'trainer' | 'club' | 'academy';
  ownerSlug?: string;
  /** Academy/club/trainer logo, centred in the QR code when present. */
  ownerLogoUrl?: string | null;
}

type SortField = 'name' | 'location' | 'start_date' | 'status' | 'applications';
type SortDirection = 'asc' | 'desc';

export default function CyclesTable({
  cycles,
  locations: _locations = [],
  onEdit,
  rowHref,
  onDuplicate,
  onDeleted,
  ownerType,
  ownerSlug,
  ownerLogoUrl,
}: CyclesTableProps) {
  const { t, i18n } = useTranslation('cycles');
  const navigate = useNavigate();
  const locale = i18n.language === 'nl' ? nl : enUS;

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [locationFilter, setLocationFilter] = useState<string>('all');

  // Sorting
  const [sortField, setSortField] = useState<SortField>('start_date');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const [cycleToDelete, setCycleToDelete] = useState<Cycle | null>(null);
  const [qrCycle, setQrCycle] = useState<Cycle | null>(null);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const handleToggleStatus = async (cycle: Cycle) => {
    const newStatus = cycle.status === 'open' ? 'closed' : 'open';
    try {
      await updateCycle(cycle.id, { status: newStatus });
      // A split registration's public form obeys registrations.status — keep it in lockstep so
      // "close" actually closes the form (audit Theme 1). No-op when there is no overlay row.
      await syncRegistrationStatus(cycle.id, newStatus);
      toast.success(t(`status.${newStatus}`));
      onDeleted(); // Refresh
    } catch (error: any) {
      toast.error(getFriendlyErrorMessage(error, t('genericError', 'Something went wrong. Please try again.')));
    }
  };

  const handleCopyLink = (cycle: Cycle) => {
    const url = buildRegistrationUrl(cycle.id, ownerType, ownerSlug, i18n.language || 'nl');
    navigator.clipboard.writeText(url);
    toast.success(t('actions.linkCopied'));
  };

  const getBasePath = () => {
    switch (ownerType) {
      case 'academy': return '/app/academy';
      case 'club': return '/app/club';
      case 'trainer': return '/app/trainer';
    }
  };

  const handleViewRequests = (cycle: Cycle) => {
    navigate(`${getBasePath()}/intake-requests?cycle=${cycle.id}`);
  };

  // Filter and sort cycles
  const filteredCycles = cycles
    .filter((cycle) => {
      if (searchQuery && !cycle.name.toLowerCase().includes(searchQuery.toLowerCase())) {
        return false;
      }
      if (statusFilter !== 'all' && cycle.status !== statusFilter) {
        return false;
      }
      if (locationFilter !== 'all' && cycle.location_id !== locationFilter) {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'location':
          comparison = (a.location?.name || '').localeCompare(b.location?.name || '');
          break;
        case 'start_date':
          comparison = new Date(a.start_date || 0).getTime() - new Date(b.start_date || 0).getTime();
          break;
        case 'status':
          comparison = a.status.localeCompare(b.status);
          break;
        case 'applications':
          comparison = (a._intakeCount || 0) - (b._intakeCount || 0);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });


  const formatPeriod = (cycle: Cycle) => {
    if (cycle.is_always_open) return t('alwaysOpen.badge', 'Always open');
    if (!cycle.start_date || !cycle.end_date) return '-';
    const start = new Date(cycle.start_date);
    const end = new Date(cycle.end_date);
    const weeks = differenceInWeeks(end, start);
    return `${format(start, 'MMM d', { locale })} - ${format(end, 'MMM d', { locale })} (${weeks}w)`;
  };

  const formatPrice = (cycle: Cycle) => {
    if (cycle.total_price) {
      return formatCurrency(cycle.total_price, { currency: cycle.currency || 'EUR' });
    }
    if (cycle.price_per_session) {
      return `${formatCurrency(cycle.price_per_session, { currency: cycle.currency || 'EUR' })}/les`;
    }
    return '-';
  };

  // Unique locations from cycles for filter
  const uniqueLocations = Array.from(
    new Map(
      cycles
        .filter((c) => c.location)
        .map((c) => [c.location!.id, c.location!])
    ).values()
  );

  const columns: ColumnDef<Cycle>[] = [
    {
      key: 'name',
      header: t('form.registrationName', 'Name'),
      sortKey: 'name',
      linkTo: rowHref ? (cycle) => rowHref(cycle) : undefined,
      renderCell: (cycle) => (
        <>
          <div className="flex items-center gap-2">
            <span className="font-medium">{cycle.name}</span>
            {cycle.type === 'event' && (
              <Badge variant="outline" className="text-xs bg-purple-500/10 text-purple-600 border-purple-500/20">
                {t('type.event', 'Event')}
              </Badge>
            )}
          </div>
          <div className="text-sm text-muted-foreground md:hidden">{cycle.location?.name || '-'}</div>
        </>
      ),
    },
    {
      key: 'location',
      header: t('common:location', 'Location'),
      sortKey: 'location',
      headClassName: 'hidden md:table-cell',
      className: 'hidden md:table-cell',
      renderCell: (cycle) =>
        cycle.location ? (
          <span className="text-sm">
            {cycle.location.name}
            <span className="text-muted-foreground ml-1">({cycle.location.city})</span>
          </span>
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    },
    {
      key: 'period',
      header: t('common:period', 'Period'),
      sortKey: 'start_date',
      headClassName: 'hidden sm:table-cell',
      className: 'hidden sm:table-cell',
      renderCell: (cycle) => <span className="text-sm">{formatPeriod(cycle)}</span>,
    },
    {
      key: 'status',
      header: t('common:status', 'Status'),
      sortKey: 'status',
      renderCell: (cycle) => <CycleStatusBadge status={cycle.status} />,
    },
    {
      key: 'applications',
      header: t('stats.applications'),
      sortKey: 'applications',
      headClassName: 'hidden lg:table-cell',
      className: 'hidden lg:table-cell',
      renderCell: (cycle) => (
        <Badge variant="outline" className="font-normal">
          <Users className="h-3 w-3 mr-1" />
          {cycle._intakeCount || 0}
        </Badge>
      ),
    },
    {
      key: 'price',
      header: t('common:price', 'Price'),
      headClassName: 'hidden lg:table-cell',
      className: 'hidden lg:table-cell text-sm',
      renderCell: (cycle) => formatPrice(cycle),
    },
  ];

  const renderRowActions = (cycle: Cycle) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Open actions menu" className="h-8 w-8">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onEdit(cycle)}>
          <Edit className="h-4 w-4 mr-2" />
          {cycle.type === 'registration' ? t('editRegistration', 'Edit Registration') : t('editCycle')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleViewRequests(cycle)}>
          <Users className="h-4 w-4 mr-2" />
          {t('actions.viewRequests')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleCopyLink(cycle)}>
          <ExternalLink className="h-4 w-4 mr-2" />
          {t('actions.shareLink')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setQrCycle(cycle)}>
          <QrCode className="h-4 w-4 mr-2" />
          {t('actions.qrCode', 'QR code')}
        </DropdownMenuItem>
        {onDuplicate && (
          <DropdownMenuItem onClick={() => onDuplicate(cycle)}>
            <Copy className="h-4 w-4 mr-2" />
            {t('common:duplicate', 'Duplicate')}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => handleToggleStatus(cycle)}>
          {cycle.status === 'open' ? (
            <>
              <ToggleLeft className="h-4 w-4 mr-2" />
              {t('actions.closeEnrollment')}
            </>
          ) : (
            <>
              <ToggleRight className="h-4 w-4 mr-2" />
              {t('actions.openEnrollment')}
            </>
          )}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => setCycleToDelete(cycle)}
          className="text-destructive focus:text-destructive"
        >
          <Trash className="h-4 w-4 mr-2" />
          {cycle.type === 'registration' ? t('deleteRegistration', 'Delete Registration') : t('deleteCycle')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('common:search', 'Search...')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <SelectFilter
          value={statusFilter}
          onValueChange={setStatusFilter}
          allLabel={t('intakeRequests.filters.all')}
          options={[
            { value: 'draft', label: t('status.draft') },
            { value: 'open', label: t('status.open') },
            { value: 'closed', label: t('status.closed') },
            { value: 'archived', label: t('status.archived') },
          ]}
          triggerClassName="w-full sm:w-[150px]"
        />
        {uniqueLocations.length > 0 && (
          <SelectFilter
            value={locationFilter}
            onValueChange={setLocationFilter}
            allLabel={t('common:allLocations', 'All locations')}
            options={uniqueLocations.map((loc) => ({ value: loc.id, label: loc.name }))}
            triggerClassName="w-full sm:w-[200px]"
          />
        )}
      </div>

      {/* Table */}
      <DataTable<Cycle>
        columns={columns}
        rows={filteredCycles}
        sortKey={sortField}
        sortDirection={sortDirection}
        onSort={(key) => handleSort(key as SortField)}
        onRowClick={onEdit}
        renderActions={renderRowActions}
        desktopOnly={false}
        empty={cycles.length === 0 ? t('noCycles') : t('common:noResults', 'No results found')}
      />

      <DeleteCycleDialog
        cycle={cycleToDelete}
        open={!!cycleToDelete}
        onOpenChange={(open) => {
          if (!open) setCycleToDelete(null);
        }}
        onDeleted={onDeleted}
      />

      {qrCycle && (
        <Suspense fallback={null}>
          <RegistrationQrDialog
            open
            onOpenChange={(open) => { if (!open) setQrCycle(null); }}
            url={buildRegistrationUrl(qrCycle.id, ownerType, ownerSlug, i18n.language || 'nl')}
            title={qrCycle.name}
            logoUrl={ownerLogoUrl}
          />
        </Suspense>
      )}
    </div>
  );
}
