import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useTableSort } from '@/hooks/useTableSort';
import { DataTable, type ColumnDef } from '@/components/ui/data-table-generic';
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
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { toast } from 'sonner';

interface TrainerOption {
  id: string;
  name: string;
}

/** Row = an intake request enriched with `_isLinked` (for the Linked-column sort). */
type IntakeRow = IntakeRequestWithProposal & { _isLinked: boolean };

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
// Bump when adding a defaultVisible column existing users (with a saved layout that
// predates it) should see. We surface those columns once; they can still hide them after.
const COLUMNS_VERSION = '2';
const VERSION_KEY = 'intake-table-columns-version';
const NEW_IN_VERSION = ['payment'];

// Column-visibility metadata (renamed from ColumnDef to avoid colliding with the engine's ColumnDef).
interface IntakeColumnMeta {
  key: string;
  labelKey: string;
  defaultVisible: boolean;
  alwaysVisible?: boolean;
}

const ALL_COLUMNS: IntakeColumnMeta[] = [
  { key: 'player', labelKey: 'intakeRequests.table.player', defaultVisible: true, alwaysVisible: true },
  { key: 'lessonType', labelKey: 'intakeRequests.table.lessonType', defaultVisible: true },
  { key: 'rating', labelKey: 'intakeRequests.table.rating', defaultVisible: true },
  { key: 'availability', labelKey: 'intakeRequests.table.availability', defaultVisible: true },
  { key: 'preferredTrainer', labelKey: 'intakeRequests.table.preferredTrainer', defaultVisible: true },
  { key: 'status', labelKey: 'intakeRequests.table.status', defaultVisible: true },
  { key: 'payment', labelKey: 'intakeRequests.table.payment', defaultVisible: true },
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
      // One-time: surface columns added after this user saved their layout (e.g. Payment).
      if (localStorage.getItem(VERSION_KEY) !== COLUMNS_VERSION) {
        NEW_IN_VERSION.forEach(k => set.add(k));
        localStorage.setItem(VERSION_KEY, COLUMNS_VERSION);
      }
      return set;
    }
  } catch { /* non-fatal: corrupt/unavailable localStorage — fall back to defaults */ }
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
      toast.error(getFriendlyErrorMessage(error, t('intakeRequests.links.linkError', { defaultValue: 'Could not link the players. Please try again.' })));
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

  // Payment status for registration/event cycles. No invoice => no payment configured
  // (free), shown as a neutral dash so it doesn't read as "unpaid".
  const renderPaymentBadge = (request: IntakeRequestWithProposal) => {
    if (request.invoice_status === 'paid') {
      return <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-500/20">{t('intakeRequests.payment.paid', { defaultValue: 'Paid' })}</Badge>;
    }
    if (request.invoice_status === 'cancelled') {
      return <Badge variant="outline" className="bg-muted text-muted-foreground">{t('intakeRequests.payment.cancelled', { defaultValue: 'Cancelled' })}</Badge>;
    }
    if (request.invoice_id) {
      return <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500/20">{t('intakeRequests.payment.unpaid', { defaultValue: 'Unpaid' })}</Badge>;
    }
    return <span className="text-muted-foreground text-sm">—</span>;
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
                    <p className="text-xs font-medium mb-1">{t('intakeRequests.table.groupMembers')}</p>
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
                  toast.error(getFriendlyErrorMessage(error, t('intakeRequests.links.linkError', { defaultValue: 'Could not link the players. Please try again.' })));
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

  // Engine columns (keys match ALL_COLUMNS / the visibility set). Order + visibility are driven by
  // the engine's `visibleKeys` (derived from the existing `visibleColumns` Set below), so the bespoke
  // localStorage persistence + versioned reveal stay exactly as they were.
  const stickyPlayer = 'sticky left-0 z-10 bg-background';
  const columns: ColumnDef<IntakeRow>[] = [
    {
      key: 'player',
      header: t('intakeRequests.table.player'),
      sortKey: 'full_name',
      className: `${stickyPlayer} max-w-[200px]`,
      headClassName: stickyPlayer,
      cellTitle: (r) => r.full_name || undefined,
      renderCell: (r) => (
        <div className="min-w-0 leading-tight">
          <div className="truncate text-sm font-medium">{r.full_name}</div>
          <div className="truncate text-xs text-muted-foreground">{r.email}</div>
        </div>
      ),
    },
    {
      key: 'lessonType',
      header: t('intakeRequests.table.lessonType'),
      renderCell: (r) => (
        <div className="flex gap-1">
          {(Array.isArray(r.lesson_type) ? r.lesson_type : [r.lesson_type]).map((type: string) => (
            <Badge key={type} variant="outline" className={`${getLessonTypeBadge(type)} shrink-0`}>
              {['private', 'duo', 'group3', 'group4', 'kids'].includes(type)
                ? t(`application.form.lessonTypes.${type}`)
                : type.charAt(0).toUpperCase() + type.slice(1)}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      key: 'rating',
      header: t('intakeRequests.table.rating'),
      sortKey: 'rating',
      renderCell: (r) =>
        r.rating ? (
          <div className="flex items-center gap-1">
            <span className="font-medium">{r.rating}</span>
            <span className="text-xs text-muted-foreground uppercase">{r.rating_system}</span>
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'availability',
      header: t('intakeRequests.table.availability'),
      className: 'whitespace-nowrap',
      renderCell: (r) => <span className="text-sm">{formatAvailability(r)}</span>,
    },
    {
      key: 'preferredTrainer',
      header: t('intakeRequests.table.preferredTrainer'),
      renderCell: (r) => getTrainerNames(r),
    },
    {
      key: 'status',
      header: t('intakeRequests.table.status'),
      renderCell: (r) => (
        <Badge variant="outline" className={getStatusColor(r.status)}>
          {t(`intakeRequests.filters.${r.status}`)}
        </Badge>
      ),
    },
    {
      key: 'payment',
      header: t('intakeRequests.table.payment', { defaultValue: 'Payment' }),
      renderCell: (r) => renderPaymentBadge(r),
    },
    {
      key: 'linked',
      header: t('intakeRequests.links.linkedColumn', { defaultValue: 'Linked' }),
      sortKey: '_isLinked',
      renderCell: (r) => renderLinkedColumn(r),
    },
    {
      key: 'proposal',
      header: t('proposals.title'),
      renderCell: (r) => renderProposalIndicator(r),
    },
    {
      key: 'applied',
      header: t('intakeRequests.table.applied'),
      sortKey: 'created_at',
      className: 'text-sm text-muted-foreground whitespace-nowrap',
      renderCell: (r) => format(new Date(r.created_at), 'MMM d'),
    },
    {
      key: 'phone',
      header: t('intakeRequests.table.phone', { defaultValue: 'Phone' }),
      className: 'text-sm whitespace-nowrap',
      renderCell: (r) => r.phone || <span className="text-muted-foreground">—</span>,
    },
    {
      key: 'sessionsPerWeek',
      header: t('intakeRequests.table.sessionsPerWeek', { defaultValue: 'Sessions/wk' }),
      className: 'text-sm',
      renderCell: (r) => r.sessions_per_week ?? <span className="text-muted-foreground">—</span>,
    },
    {
      key: 'duration',
      header: t('intakeRequests.table.duration', { defaultValue: 'Duration' }),
      className: 'text-sm whitespace-nowrap',
      renderCell: (r) =>
        r.preferred_duration_minutes ? `${r.preferred_duration_minutes} min` : <span className="text-muted-foreground">—</span>,
    },
    {
      key: 'birthDate',
      header: t('intakeRequests.table.birthDate', { defaultValue: 'Birth date' }),
      className: 'text-sm text-muted-foreground whitespace-nowrap',
      renderCell: (r) => (r.birth_date ? format(new Date(r.birth_date), 'MMM d, yyyy') : '—'),
    },
    {
      key: 'notes',
      header: t('intakeRequests.table.notes', { defaultValue: 'Notes' }),
      className: 'max-w-[170px]',
      renderCell: (r) =>
        r.notes ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-sm truncate max-w-[150px] block cursor-help">
                  {r.notes.length > 30 ? r.notes.slice(0, 30) + '…' : r.notes}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                <p className="text-sm whitespace-pre-wrap">{r.notes}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <span className="text-muted-foreground text-sm">—</span>
        ),
    },
  ];

  // Ordered list of visible column keys → the engine renders exactly these, in ALL_COLUMNS order.
  const visibleKeys = ALL_COLUMNS.map((c) => c.key).filter((k) => visibleColumns.has(k));

  // Mobile card list (the ~15-column table is unreadable at phone width) — passed to the engine's
  // `mobile` slot. Inner link/proposal popovers already stopPropagation.
  const mobileCards = (
    <div className="md:hidden divide-y">
      {displayedRequests.map((request) => (
        <div
          key={request.id}
          className="cursor-pointer px-4 py-3 transition-colors hover:bg-muted/50"
          onClick={() => onRowClick(request)}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate font-medium">{request.full_name}</div>
              <div className="truncate text-sm text-muted-foreground">{request.email}</div>
            </div>
            <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
              {format(new Date(request.created_at), 'MMM d')}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className={getStatusColor(request.status)}>
              {t(`intakeRequests.filters.${request.status}`)}
            </Badge>
            {renderPaymentBadge(request)}
            {renderProposalIndicator(request)}
            {renderLinkedColumn(request)}
          </div>
        </div>
      ))}
    </div>
  );

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

      <DataTable<IntakeRow>
        columns={columns}
        rows={displayedRequests}
        visibleKeys={visibleKeys}
        sortKey={sortConfig.key as string | null}
        sortDirection={sortConfig.direction}
        onSort={(k) => handleSort(k as keyof IntakeRow)}
        onRowClick={onRowClick}
        compact
        mobile={mobileCards}
        empty={t('intakeRequests.table.noMatches', { defaultValue: 'No matching requests' })}
      />
    </div>
  );
}
