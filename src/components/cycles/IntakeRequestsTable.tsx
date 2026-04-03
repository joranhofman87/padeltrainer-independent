import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useTableSort } from '@/hooks/useTableSort';
import { SortableTableHead } from '@/components/admin/SortableTableHead';
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
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { 
  FileText, 
  AlertCircle, 
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Clock,
  Link2,
  Lightbulb,
  Plus,
  X,
  Settings2,
  Search,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { type IntakeRequestWithProposal, type PlayerLink, linkPlayers } from '@/lib/cycles';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { getSuggestedLinks, getDismissedSuggestions, dismissSuggestion, getLinkedIdsForRequest, getUnmatchedMentions, getDismissedUnmatched, dismissUnmatchedMention } from '@/lib/suggestLinks';
import { toast } from 'sonner';

interface TrainerOption {
  id: string;
  name: string;
}

interface IntakeRequestsTableProps {
  requests: IntakeRequestWithProposal[];
  allRequests?: IntakeRequestWithProposal[];
  trainers?: TrainerOption[];
  onRowClick: (request: IntakeRequestWithProposal) => void;
  emptyMessage?: string;
  emptyDescription?: string;
  playerLinks?: PlayerLink[];
  onLinkChanged?: () => void;
}

const LINK_COLORS = [
  'bg-blue-500', 'bg-green-500', 'bg-orange-500', 'bg-purple-500',
  'bg-pink-500', 'bg-cyan-500', 'bg-yellow-500', 'bg-red-500',
];

const STORAGE_KEY = 'intake-table-columns';

interface ColumnDef {
  key: string;
  labelKey: string;
  defaultVisible: boolean;
  alwaysVisible?: boolean;
}

const ALL_COLUMNS: ColumnDef[] = [
  { key: 'player', labelKey: 'intakeRequests.table.player', defaultVisible: true, alwaysVisible: true },
  { key: 'lessonType', labelKey: 'intakeRequests.table.lessonType', defaultVisible: true },
  { key: 'rating', labelKey: 'intakeRequests.table.rating', defaultVisible: true },
  { key: 'availability', labelKey: 'intakeRequests.table.availability', defaultVisible: true },
  { key: 'preferredTrainer', labelKey: 'intakeRequests.table.preferredTrainer', defaultVisible: true },
  { key: 'status', labelKey: 'intakeRequests.table.status', defaultVisible: true },
  { key: 'linked', labelKey: 'intakeRequests.links.linkedColumn', defaultVisible: true },
  { key: 'proposal', labelKey: 'proposals.title', defaultVisible: true },
  { key: 'applied', labelKey: 'intakeRequests.table.applied', defaultVisible: true },
  { key: 'phone', labelKey: 'intakeRequests.table.phone', defaultVisible: false },
  { key: 'sessionsPerWeek', labelKey: 'intakeRequests.table.sessionsPerWeek', defaultVisible: false },
  { key: 'duration', labelKey: 'intakeRequests.table.duration', defaultVisible: false },
  { key: 'birthDate', labelKey: 'intakeRequests.table.birthDate', defaultVisible: false },
  { key: 'notes', labelKey: 'intakeRequests.table.notes', defaultVisible: false },
];

function getDefaultColumns(): Set<string> {
  return new Set(ALL_COLUMNS.filter(c => c.defaultVisible).map(c => c.key));
}

function loadColumns(): Set<string> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const arr = JSON.parse(stored) as string[];
      const set = new Set(arr);
      // Always include alwaysVisible
      ALL_COLUMNS.filter(c => c.alwaysVisible).forEach(c => set.add(c.key));
      return set;
    }
  } catch {}
  return getDefaultColumns();
}

export default function IntakeRequestsTable({
  requests,
  allRequests = [],
  trainers = [],
  onRowClick,
  emptyMessage = 'No requests',
  emptyDescription = 'Applications will appear here when players sign up',
  playerLinks = [],
  onLinkChanged,
}: IntakeRequestsTableProps) {
  const { t } = useTranslation('cycles');
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(loadColumns);
  const [dismissVersion, setDismissVersion] = useState(0);
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const filteredRequests = useMemo(() => {
    if (!searchQuery.trim()) return requests;
    const q = searchQuery.toLowerCase();
    return requests.filter(r => r.full_name?.toLowerCase().includes(q));
  }, [requests, searchQuery]);

  // Enrich with _isLinked for sorting
  const enrichedRequests = useMemo(() => {
    const linkedSet = new Set(playerLinks.map(pl => pl.intake_request_id));
    return filteredRequests.map(r => ({
      ...r,
      _isLinked: linkedSet.has(r.id),
    }));
  }, [filteredRequests, playerLinks]);

  const { sortedData: displayedRequests, sortConfig, handleSort } = useTableSort(enrichedRequests);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...visibleColumns]));
  }, [visibleColumns]);

  const toggleColumn = (key: string) => {
    setVisibleColumns(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const isVisible = (key: string) => visibleColumns.has(key);

  // Compute suggestions for all requests
  const suggestionsMap = useMemo(() => {
    if (!allRequests.length) return new Map<string, IntakeRequestWithProposal[]>();
    const dismissed = getDismissedSuggestions();
    const map = new Map<string, IntakeRequestWithProposal[]>();
    for (const req of requests) {
      const linkedIds = new Set(getLinkedIdsForRequest(req.id, playerLinks));
      const suggestions = getSuggestedLinks(req, allRequests, linkedIds, dismissed);
      if (suggestions.length > 0) {
        map.set(req.id, suggestions);
      }
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests, allRequests, playerLinks, dismissVersion]);

  // Compute unmatched mentions for all requests
  const unmatchedMap = useMemo(() => {
    if (!allRequests.length) return new Map<string, string[]>();
    const dismissed = getDismissedUnmatched();
    const map = new Map<string, string[]>();
    for (const req of requests) {
      const unmatched = getUnmatchedMentions(req, allRequests, dismissed);
      if (unmatched.length > 0) {
        map.set(req.id, unmatched);
      }
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests, allRequests, dismissVersion]);

  const handleLinkFromTable = async (requestId: string, suggestedId: string) => {
    setLinkingId(suggestedId);
    try {
      const linkedIds = getLinkedIdsForRequest(requestId, playerLinks);
      if (linkedIds.length > 0) {
        await linkPlayers([requestId, ...linkedIds, suggestedId]);
      } else {
        await linkPlayers([requestId, suggestedId]);
      }
      toast.success(t('intakeRequests.links.linked', { defaultValue: 'Players linked' }));
      onLinkChanged?.();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setLinkingId(null);
    }
  };

  const handleDismissFromTable = (requestId: string, suggestedId: string) => {
    dismissSuggestion(requestId, suggestedId);
    setDismissVersion(v => v + 1);
  };

  // Build link group map
  const linkGroupMap = new Map<string, string>();
  const linkGroups = new Map<string, string[]>();
  playerLinks.forEach(pl => {
    linkGroupMap.set(pl.intake_request_id, pl.link_group);
    const existing = linkGroups.get(pl.link_group) || [];
    existing.push(pl.intake_request_id);
    linkGroups.set(pl.link_group, existing);
  });

  const groupColors = new Map<string, string>();
  let colorIdx = 0;
  linkGroups.forEach((_, groupId) => {
    groupColors.set(groupId, LINK_COLORS[colorIdx % LINK_COLORS.length]);
    colorIdx++;
  });

  const getTrainerNames = (request: IntakeRequestWithProposal): React.ReactNode => {
    const ids = request.preferred_trainer_ids || [];
    if (ids.length === 0) return <span className="text-muted-foreground">—</span>;
    const names = ids
      .map(id => trainers.find(t => t.id === id)?.name)
      .filter(Boolean) as string[];
    if (names.length === 0) return <span className="text-muted-foreground">—</span>;
    if (names.length === 1) return <span className="text-sm">{names[0]}</span>;
    if (names.length === 2) return <span className="text-sm">{names[0]}, {names[1]}</span>;
    return <span className="text-sm">{names[0]} <span className="text-muted-foreground">+{names.length - 1}</span></span>;
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'new': return 'bg-blue-500/10 text-blue-600 border-blue-500/20';
      case 'proposed': return 'bg-purple-500/10 text-purple-600 border-purple-500/20';
      case 'confirmed': return 'bg-green-500/10 text-green-600 border-green-500/20';
      case 'waitlist': return 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20';
      case 'rejected': return 'bg-red-500/10 text-red-600 border-red-500/20';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  const formatAvailability = (request: IntakeRequestWithProposal) => {
    const timeWindows = (request.preferred_time_windows || []) as Array<{ day?: string; start?: string; end?: string }>;
    const windowsByDay = new Map<string, Array<{ start: string; end: string }>>();
    timeWindows.forEach(tw => {
      if (tw.day && tw.start && tw.end) {
        const existing = windowsByDay.get(tw.day) || [];
        existing.push({ start: tw.start, end: tw.end });
        windowsByDay.set(tw.day, existing);
      }
    });
    const days = request.preferred_days || [];
    if (days.length === 0 && windowsByDay.size === 0) return '—';
    const dayOrder = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const uniqueDays = [...new Set([...days, ...windowsByDay.keys()])].sort(
      (a, b) => dayOrder.indexOf(a) - dayOrder.indexOf(b)
    );
    return uniqueDays.slice(0, 3).map(day => {
      const abbr = day.charAt(0).toUpperCase() + day.slice(1, 3);
      const windows = windowsByDay.get(day) || [];
      if (windows.length > 0) {
        const timeStr = windows.map(w => `${w.start.slice(0, 5)}-${w.end.slice(0, 5)}`).join(', ');
        return `${abbr} ${timeStr}`;
      }
      return abbr;
    }).join(', ') + (uniqueDays.length > 3 ? ` +${uniqueDays.length - 3}` : '');
  };

  const getLessonTypeBadge = (lessonType: string) => {
    const colors: Record<string, string> = {
      private: 'bg-primary/10 text-primary',
      duo: 'bg-orange-500/10 text-orange-600',
      group: 'bg-cyan-500/10 text-cyan-600',
      kids: 'bg-pink-500/10 text-pink-600'
    };
    return colors[lessonType] || 'bg-muted text-muted-foreground';
  };

  const renderProposalIndicator = (request: IntakeRequestWithProposal) => {
    if (request.status === 'confirmed') {
      return (
        <div className="flex items-center gap-1 text-green-600">
          <CheckCircle2 className="h-4 w-4" />
        </div>
      );
    }

    if (request.status === 'proposed' && request.proposal) {
      return (
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 text-purple-500" />
            <span className="font-medium text-sm">
              {request.proposal.slot_day.slice(0, 3)} {request.proposal.slot_time.split(' - ')[0]}
            </span>
            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 bg-purple-500/10 text-purple-600 border-purple-500/20">
              {request.proposal.confidence_score}%
            </Badge>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Avatar className="h-4 w-4">
              <AvatarImage src={request.proposal.trainer_avatar || undefined} />
              <AvatarFallback className="text-[8px] bg-muted">
                {request.proposal.trainer_name[0]}
              </AvatarFallback>
            </Avatar>
            <span className="truncate max-w-[80px]">{request.proposal.trainer_name}</span>
            {request.proposal.group_members.length > 0 && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-muted-foreground cursor-help">
                      +{request.proposal.group_members.length}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs font-medium mb-1">Group members:</p>
                    <ul className="text-xs">
                      {request.proposal.group_members.map((name, i) => (
                        <li key={i}>{name}</li>
                      ))}
                    </ul>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>
      );
    }

    if (request.status === 'proposed') {
      return (
        <div className="flex items-center gap-1 text-purple-600">
          <Calendar className="h-4 w-4" />
          <span className="text-xs">{t('intakeRequests.filters.proposed')}</span>
        </div>
      );
    }

    if (request.status === 'new' && request.skip_reason) {
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1 text-yellow-600 cursor-help">
                <AlertCircle className="h-4 w-4" />
                <span className="text-xs">{t(`skipReasons.${request.skip_reason}.short`)}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-sm">{t(`skipReasons.${request.skip_reason}.description`)}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    }

    return <span className="text-muted-foreground text-xs">—</span>;
  };

  const renderLinkedColumn = (request: IntakeRequestWithProposal) => {
    const requestId = request.id;
    const groupId = linkGroupMap.get(requestId);
    const suggestions = suggestionsMap.get(requestId) || [];
    const unmatchedMentions = unmatchedMap.get(requestId) || [];

    const linkedContent = (() => {
      if (!groupId) return null;
      const color = groupColors.get(groupId) || 'bg-muted';
      const members = linkGroups.get(groupId) || [];
      const memberNames = members
        .filter(id => id !== requestId)
        .map(id => requests.find(r => r.id === id)?.full_name)
        .filter(Boolean);
      if (memberNames.length === 0) return null;
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5">
                <span className={`inline-block h-2.5 w-2.5 rounded-full ${color} shrink-0`} />
                <Link2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-xs text-muted-foreground truncate max-w-[100px]">
                  {memberNames.length === 1 ? memberNames[0] : `${memberNames[0]} +${memberNames.length - 1}`}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-xs font-medium mb-1">{t('intakeRequests.links.linkedWith', { defaultValue: 'Linked with' })}:</p>
              <ul className="text-xs">
                {memberNames.map((name, i) => (
                  <li key={i}>{name}</li>
                ))}
              </ul>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    })();

    const suggestionIndicator = suggestions.length > 0 ? (
      <Popover>
        <PopoverTrigger asChild>
          <button
            onClick={(e) => e.stopPropagation()}
            className="relative inline-flex items-center gap-1 text-amber-600 hover:text-amber-700 transition-colors"
            title={t('intakeRequests.links.suggestions', { defaultValue: 'Suggestions' })}
          >
            <Lightbulb className="h-4 w-4" />
            <span className="text-xs font-medium">{suggestions.length}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="w-64 p-3"
          align="start"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-xs font-medium mb-2">
            {t('intakeRequests.links.suggestedLinks', { defaultValue: 'Suggested links' })}
          </p>
          <div className="space-y-1.5">
            {suggestions.map(s => (
              <div key={s.id} className="flex items-center justify-between gap-2">
                <span className="text-sm truncate">{s.full_name}</span>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0"
                    disabled={linkingId === s.id}
                    onClick={() => handleLinkFromTable(requestId, s.id)}
                    title={t('intakeRequests.links.link', { defaultValue: 'Link' })}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                    onClick={() => handleDismissFromTable(requestId, s.id)}
                    title={t('intakeRequests.links.dismissSuggestion', { defaultValue: 'Dismiss' })}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
          {suggestions.length > 1 && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs mt-2 w-full"
              disabled={linkingId !== null}
              onClick={async () => {
                setLinkingId('all');
                try {
                  const linkedIds = getLinkedIdsForRequest(requestId, playerLinks);
                  const allIds = [requestId, ...linkedIds, ...suggestions.map(s => s.id)];
                  await linkPlayers([...new Set(allIds)]);
                  toast.success(t('intakeRequests.links.linked', { defaultValue: 'Players linked' }));
                  onLinkChanged?.();
                } catch (error: any) {
                  toast.error(error.message);
                } finally {
                  setLinkingId(null);
                }
              }}
            >
              <Plus className="h-3 w-3 mr-1" />
              {t('intakeRequests.links.linkAll', { defaultValue: 'Link all' })}
            </Button>
          )}
        </PopoverContent>
      </Popover>
    ) : null;

    const unmatchedIndicator = unmatchedMentions.length > 0 ? (
      <Popover>
        <PopoverTrigger asChild>
          <button
            onClick={(e) => e.stopPropagation()}
            className="relative inline-flex items-center gap-1 text-orange-500 hover:text-orange-600 transition-colors"
            title={t('intakeRequests.links.unmatchedMentions', { defaultValue: 'Unmatched names' })}
          >
            <AlertTriangle className="h-4 w-4" />
            <span className="text-xs font-medium">{unmatchedMentions.length}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="w-72 p-3"
          align="start"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-xs font-medium mb-1">
            {t('intakeRequests.links.unmatchedMentions', { defaultValue: 'Names not found in registrations' })}
          </p>
          <p className="text-xs text-muted-foreground mb-2">
            {t('intakeRequests.links.unmatchedDescription', { defaultValue: 'These names were mentioned in the notes but no matching registration was found.' })}
          </p>
          <div className="space-y-1.5">
            {unmatchedMentions.map((name, i) => (
              <div key={i} className="flex items-center justify-between gap-2">
                <span className="text-sm truncate">{name}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive shrink-0"
                  onClick={() => {
                    dismissUnmatchedMention(requestId, name);
                    setDismissVersion(v => v + 1);
                  }}
                  title={t('intakeRequests.links.dismissSuggestion', { defaultValue: 'Dismiss' })}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    ) : null;

    if (!linkedContent && !suggestionIndicator && !unmatchedIndicator) {
      return <span className="text-muted-foreground text-xs">—</span>;
    }

    return (
      <div className="flex items-center gap-2">
        {linkedContent}
        {suggestionIndicator}
        {unmatchedIndicator}
      </div>
    );
  };

  if (requests.length === 0) {
    return (
      <Card>
        <CardContent className="py-16">
          <div className="text-center">
            <div className="mx-auto h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-4">
              <FileText className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="font-semibold mb-1">{emptyMessage}</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              {emptyDescription}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {/* Search + Column visibility toggle */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('intakeRequests.table.searchPlayer', { defaultValue: 'Search player...' })}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 h-9"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5">
              <Settings2 className="h-4 w-4" />
              {t('intakeRequests.table.columns', { defaultValue: 'Columns' })}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel>{t('intakeRequests.table.toggleColumns', { defaultValue: 'Toggle columns' })}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {ALL_COLUMNS.filter(c => !c.alwaysVisible).map(col => (
              <DropdownMenuCheckboxItem
                key={col.key}
                checked={visibleColumns.has(col.key)}
                onCheckedChange={() => toggleColumn(col.key)}
              >
                {t(col.labelKey, { defaultValue: col.key })}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 z-10 bg-background">{t('intakeRequests.table.player')}</TableHead>
                  {isVisible('lessonType') && <TableHead>{t('intakeRequests.table.lessonType')}</TableHead>}
                  {isVisible('rating') && <TableHead>{t('intakeRequests.table.rating')}</TableHead>}
                  {isVisible('availability') && <TableHead>{t('intakeRequests.table.availability')}</TableHead>}
                  {isVisible('preferredTrainer') && <TableHead>{t('intakeRequests.table.preferredTrainer')}</TableHead>}
                  {isVisible('status') && <TableHead>{t('intakeRequests.table.status')}</TableHead>}
                  {isVisible('linked') && <TableHead>{t('intakeRequests.links.linkedColumn', { defaultValue: 'Linked' })}</TableHead>}
                  {isVisible('proposal') && <TableHead>{t('proposals.title')}</TableHead>}
                  {isVisible('applied') && <TableHead>{t('intakeRequests.table.applied')}</TableHead>}
                  {isVisible('phone') && <TableHead>{t('intakeRequests.table.phone', { defaultValue: 'Phone' })}</TableHead>}
                  {isVisible('sessionsPerWeek') && <TableHead>{t('intakeRequests.table.sessionsPerWeek', { defaultValue: 'Sessions/wk' })}</TableHead>}
                  {isVisible('duration') && <TableHead>{t('intakeRequests.table.duration', { defaultValue: 'Duration' })}</TableHead>}
                  {isVisible('birthDate') && <TableHead>{t('intakeRequests.table.birthDate', { defaultValue: 'Birth date' })}</TableHead>}
                  {isVisible('notes') && <TableHead>{t('intakeRequests.table.notes', { defaultValue: 'Notes' })}</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayedRequests.map((request) => (
                  <TableRow 
                    key={request.id} 
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => onRowClick(request)}
                  >
                    {/* Player - always visible, sticky */}
                    <TableCell className="sticky left-0 z-10 bg-background">
                      <div>
                        <div className="font-medium">{request.full_name}</div>
                        <div className="text-sm text-muted-foreground">{request.email}</div>
                      </div>
                    </TableCell>

                    {isVisible('lessonType') && (
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {(Array.isArray(request.lesson_type) ? request.lesson_type : [request.lesson_type]).map((type: string) => (
                            <Badge key={type} variant="outline" className={getLessonTypeBadge(type)}>
                              {['private','duo','group3','group4','kids'].includes(type)
                                ? t(`application.form.lessonTypes.${type}`)
                                : type.charAt(0).toUpperCase() + type.slice(1)}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                    )}

                    {isVisible('rating') && (
                      <TableCell>
                        {request.rating ? (
                          <div className="flex items-center gap-1">
                            <span className="font-medium">{request.rating}</span>
                            <span className="text-xs text-muted-foreground uppercase">
                              {request.rating_system}
                            </span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    )}

                    {isVisible('availability') && (
                      <TableCell>
                        <span className="text-sm whitespace-nowrap">{formatAvailability(request)}</span>
                      </TableCell>
                    )}

                    {isVisible('preferredTrainer') && (
                      <TableCell>
                        {getTrainerNames(request)}
                      </TableCell>
                    )}

                    {isVisible('status') && (
                      <TableCell>
                        <Badge variant="outline" className={getStatusColor(request.status)}>
                          {t(`intakeRequests.filters.${request.status}`)}
                        </Badge>
                      </TableCell>
                    )}

                    {isVisible('linked') && (
                      <TableCell>
                        {renderLinkedColumn(request)}
                      </TableCell>
                    )}

                    {isVisible('proposal') && (
                      <TableCell>
                        {renderProposalIndicator(request)}
                      </TableCell>
                    )}

                    {isVisible('applied') && (
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {format(new Date(request.created_at), 'MMM d')}
                      </TableCell>
                    )}

                    {isVisible('phone') && (
                      <TableCell className="text-sm whitespace-nowrap">
                        {request.phone || <span className="text-muted-foreground">—</span>}
                      </TableCell>
                    )}

                    {isVisible('sessionsPerWeek') && (
                      <TableCell className="text-sm">
                        {request.sessions_per_week ?? <span className="text-muted-foreground">—</span>}
                      </TableCell>
                    )}

                    {isVisible('duration') && (
                      <TableCell className="text-sm whitespace-nowrap">
                        {request.preferred_duration_minutes
                          ? `${request.preferred_duration_minutes} min`
                          : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                    )}

                    {isVisible('birthDate') && (
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {request.birth_date
                          ? format(new Date(request.birth_date), 'MMM d, yyyy')
                          : '—'}
                      </TableCell>
                    )}

                    {isVisible('notes') && (
                      <TableCell>
                        {request.notes ? (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="text-sm truncate max-w-[150px] block cursor-help">
                                  {request.notes.length > 30 ? request.notes.slice(0, 30) + '…' : request.notes}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs">
                                <p className="text-sm whitespace-pre-wrap">{request.notes}</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        ) : (
                          <span className="text-muted-foreground text-sm">—</span>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
