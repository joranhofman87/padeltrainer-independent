import { useState } from 'react';
import { getMarketingUrl } from '@/lib/domains';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { format, differenceInWeeks } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  MoreHorizontal,
  Plus,
  Copy,
  Edit,
  Trash,
  ExternalLink,
  Users,
  ToggleLeft,
  ToggleRight,
  Search,
  ArrowUpDown,
} from 'lucide-react';
import { type Cycle, updateCycle, deleteCycle } from '@/lib/cycles';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface CyclesTableProps {
  cycles: Cycle[];
  locations?: { id: string; name: string; city: string }[];
  onEdit: (cycle: Cycle) => void;
  onDuplicate?: (cycle: Cycle) => void;
  onDeleted: () => void;
  ownerType: 'trainer' | 'club' | 'academy';
}

type SortField = 'name' | 'location' | 'start_date' | 'status' | 'applications';
type SortDirection = 'asc' | 'desc';

export default function CyclesTable({
  cycles,
  locations = [],
  onEdit,
  onDuplicate,
  onDeleted,
  ownerType,
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
      toast.success(t(`status.${newStatus}`));
      onDeleted(); // Refresh
    } catch (error: any) {
      toast.error(error.message);
    }
  };

  const handleDelete = async (cycle: Cycle) => {
    if (!confirm((cycle.type === 'registration' ? t('deleteRegistration', 'Delete Registration') : t('deleteCycle')) + '?')) return;
    try {
      await deleteCycle(cycle.id);
      toast.success(t('common:deleted', 'Deleted'));
      onDeleted();
    } catch (error: any) {
      toast.error(error.message);
    }
  };

  const handleCopyLink = (cycle: Cycle) => {
    const lang = i18n.language || 'nl';
    const url = getMarketingUrl(`register/${cycle.id}`, lang);
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
          comparison = new Date(a.start_date).getTime() - new Date(b.start_date).getTime();
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

  const getStatusBadge = (status: string) => {
    const variants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
      draft: 'secondary',
      open: 'default',
      closed: 'outline',
      archived: 'secondary',
    };
    const colors: Record<string, string> = {
      draft: 'bg-muted text-muted-foreground',
      open: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20',
      closed: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20',
      archived: 'bg-muted text-muted-foreground',
    };
    return (
      <Badge variant={variants[status]} className={colors[status]}>
        {t(`status.${status}`)}
      </Badge>
    );
  };

  const formatPeriod = (startDate: string, endDate: string) => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const weeks = differenceInWeeks(end, start);
    return `${format(start, 'MMM d', { locale })} - ${format(end, 'MMM d', { locale })} (${weeks}w)`;
  };

  const formatPrice = (cycle: Cycle) => {
    if (cycle.total_price) {
      return new Intl.NumberFormat(i18n.language, {
        style: 'currency',
        currency: cycle.currency || 'EUR',
      }).format(cycle.total_price);
    }
    if (cycle.price_per_session) {
      return `${new Intl.NumberFormat(i18n.language, {
        style: 'currency',
        currency: cycle.currency || 'EUR',
      }).format(cycle.price_per_session)}/les`;
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

  const SortableHeader = ({ field, children }: { field: SortField; children: React.ReactNode }) => (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-3 h-8 data-[state=open]:bg-accent"
      onClick={() => handleSort(field)}
    >
      {children}
      <ArrowUpDown className="ml-2 h-4 w-4" />
    </Button>
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
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-[150px]">
            <SelectValue placeholder={t('intakeRequests.filters.all')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('intakeRequests.filters.all')}</SelectItem>
            <SelectItem value="draft">{t('status.draft')}</SelectItem>
            <SelectItem value="open">{t('status.open')}</SelectItem>
            <SelectItem value="closed">{t('status.closed')}</SelectItem>
            <SelectItem value="archived">{t('status.archived')}</SelectItem>
          </SelectContent>
        </Select>
        {uniqueLocations.length > 0 && (
          <Select value={locationFilter} onValueChange={setLocationFilter}>
            <SelectTrigger className="w-full sm:w-[200px]">
              <SelectValue placeholder={t('common:allLocations', 'All locations')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('common:allLocations', 'All locations')}</SelectItem>
              {uniqueLocations.map((loc) => (
                <SelectItem key={loc.id} value={loc.id}>
                  {loc.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <SortableHeader field="name">{t('form.registrationName', 'Name')}</SortableHeader>
              </TableHead>
              <TableHead className="hidden md:table-cell">
                <SortableHeader field="location">{t('common:location', 'Location')}</SortableHeader>
              </TableHead>
              <TableHead className="hidden sm:table-cell">
                <SortableHeader field="start_date">{t('common:period', 'Period')}</SortableHeader>
              </TableHead>
              <TableHead>
                <SortableHeader field="status">{t('common:status', 'Status')}</SortableHeader>
              </TableHead>
              <TableHead className="hidden lg:table-cell">
                <SortableHeader field="applications">{t('stats.applications')}</SortableHeader>
              </TableHead>
              <TableHead className="hidden lg:table-cell">{t('common:price', 'Price')}</TableHead>
              <TableHead className="w-[50px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredCycles.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                  {cycles.length === 0 ? t('noCycles') : t('common:noResults', 'No results found')}
                </TableCell>
              </TableRow>
            ) : (
              filteredCycles.map((cycle) => (
                <TableRow key={cycle.id} className="cursor-pointer" onClick={() => onEdit(cycle)}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{cycle.name}</span>
                      {cycle.type === 'event' && (
                        <Badge variant="outline" className="text-xs bg-purple-500/10 text-purple-600 border-purple-500/20">
                          {t('type.event', 'Event')}
                        </Badge>
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground md:hidden">
                      {cycle.location?.name || '-'}
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {cycle.location ? (
                      <span className="text-sm">
                        {cycle.location.name}
                        <span className="text-muted-foreground ml-1">({cycle.location.city})</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <span className="text-sm">{formatPeriod(cycle.start_date, cycle.end_date)}</span>
                  </TableCell>
                  <TableCell>{getStatusBadge(cycle.status)}</TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <Badge variant="outline" className="font-normal">
                      <Users className="h-3 w-3 mr-1" />
                      {cycle._intakeCount || 0}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-sm">
                    {formatPrice(cycle)}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
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
                          onClick={() => handleDelete(cycle)}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash className="h-4 w-4 mr-2" />
                          {cycle.type === 'registration' ? t('deleteRegistration', 'Delete Registration') : t('deleteCycle')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
