import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  User,
  Mail,
  Phone,
  Calendar,
  Clock,
  MapPin,
  Star,
  FileText,
  CheckCircle2,
  XCircle,
  Clock3,
  Sparkles,
  AlertCircle,
  Trash2,
  Pencil,
  Link2,
  Plus,
  X,
  Lightbulb,
  AlertTriangle,
} from 'lucide-react';
import { 
  type IntakeRequestWithProposal, 
  type EnrichedProposedAssignment,
  type PlayerLink,
  updateIntakeRequestStatus,
  getProposedAssignmentForRequest,
  deleteIntakeRequest,
  linkPlayers,
  unlinkPlayer,
} from '@/lib/cycles';
import { getSuggestedLinks, getDismissedSuggestions, dismissSuggestion, getUnmatchedMentions, getDismissedUnmatched, dismissUnmatchedMention } from '@/lib/suggestLinks';
import ProposalCard from './ProposalCard';
import EditIntakeRequestDialog from './EditIntakeRequestDialog';

interface IntakeRequestDetailSheetProps {
  request: IntakeRequestWithProposal | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStatusChange?: () => void;
  cycleId?: string;
  playerLinks?: PlayerLink[];
  allRequests?: IntakeRequestWithProposal[];
  onLinkChanged?: () => void;
}

export default function IntakeRequestDetailSheet({
  request,
  open,
  onOpenChange,
  onStatusChange,
  cycleId,
  playerLinks = [],
  allRequests = [],
  onLinkChanged,
}: IntakeRequestDetailSheetProps) {
  const { t } = useTranslation('cycles');
  const [proposal, setProposal] = useState<EnrichedProposedAssignment | null>(null);
  const [isLoadingProposal, setIsLoadingProposal] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false);
  const [isLinking, setIsLinking] = useState(false);
  const [optimisticLinkedIds, setOptimisticLinkedIds] = useState<string[]>([]);

  // Reset optimistic state when request or playerLinks change from parent
  useEffect(() => {
    setOptimisticLinkedIds([]);
  }, [playerLinks, request?.id]);

  useEffect(() => {
    const fetchProposal = async () => {
      if (!request) return;
      
      setIsLoadingProposal(true);
      try {
        const data = await getProposedAssignmentForRequest(request.id);
        setProposal(data);
      } catch (error) {
        logger.error('Error fetching proposal', error instanceof Error ? error : new Error(String(error)), { component: 'IntakeRequestDetailSheet' });
      } finally {
        setIsLoadingProposal(false);
      }
    };

    if (open && request) {
      fetchProposal();
    }
  }, [request, open]);

  // Compute linked players for current request
  const currentLinkGroup = useMemo(() => {
    if (!request) return null;
    const link = playerLinks.find(pl => pl.intake_request_id === request.id);
    return link?.link_group ?? null;
  }, [request, playerLinks]);

  const baseLinkedRequestIds = useMemo(() => {
    if (!currentLinkGroup) return [];
    return playerLinks
      .filter(pl => pl.link_group === currentLinkGroup && pl.intake_request_id !== request?.id)
      .map(pl => pl.intake_request_id);
  }, [currentLinkGroup, playerLinks, request]);

  // Merge base linked IDs with optimistic additions
  const linkedRequestIds = useMemo(() => {
    const merged = new Set([...baseLinkedRequestIds, ...optimisticLinkedIds]);
    return [...merged];
  }, [baseLinkedRequestIds, optimisticLinkedIds]);

  const linkedRequests = useMemo(() => {
    return linkedRequestIds
      .map(id => allRequests.find(r => r.id === id))
      .filter(Boolean) as IntakeRequestWithProposal[];
  }, [linkedRequestIds, allRequests]);

  // Auto-suggest links from notes (using shared utility)
  const dismissed = useMemo(() => getDismissedSuggestions(), []);
  const [dismissVersion, setDismissVersion] = useState(0);
  const suggestedLinks = useMemo(() => {
    if (!request) return [];
    const currentDismissed = getDismissedSuggestions();
    return getSuggestedLinks(request, allRequests, new Set(linkedRequestIds), currentDismissed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, allRequests, linkedRequestIds, dismissVersion]);

  // Compute unmatched mentions
  const unmatchedMentions = useMemo(() => {
    if (!request) return [];
    const dismissed = getDismissedUnmatched();
    return getUnmatchedMentions(request, allRequests, dismissed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, allRequests, dismissVersion]);

  // Available requests to link (same cycle, not already linked to this group, not self)
  const availableToLink = useMemo(() => {
    if (!request) return [];
    const currentCycleId = request.cycle_id;
    const alreadyLinkedIds = new Set([request.id, ...linkedRequestIds]);
    return allRequests.filter(r => 
      r.cycle_id === currentCycleId && 
      !alreadyLinkedIds.has(r.id)
    );
  }, [request, allRequests, linkedRequestIds]);

  const handleStatusChange = async (newStatus: IntakeRequestWithProposal['status']) => {
    if (!request) return;

    setIsUpdating(true);
    try {
      await updateIntakeRequestStatus(request.id, newStatus);
      toast.success(`Status updated to ${newStatus}`);
      onStatusChange?.();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDelete = async () => {
    if (!request) return;

    setIsDeleting(true);
    try {
      await deleteIntakeRequest(request.id);
      toast.success(t('intakeRequests.actions.deleteSuccess'));
      onOpenChange(false);
      onStatusChange?.();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleLinkPlayer = async (targetRequestId: string) => {
    if (!request) return;
    setIsLinking(true);
    try {
      if (currentLinkGroup && linkedRequestIds.length > 0) {
        await linkPlayers([request.id, ...linkedRequestIds, targetRequestId]);
      } else {
        await linkPlayers([request.id, targetRequestId]);
      }
      // Optimistic: add to local linked IDs immediately
      setOptimisticLinkedIds(prev => [...prev, targetRequestId]);
      toast.success(t('intakeRequests.links.linked', { defaultValue: 'Players linked' }));
      setLinkPopoverOpen(false);
      // Fire-and-forget background refresh
      onLinkChanged?.();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setIsLinking(false);
    }
  };

  const handleUnlinkPlayer = async (targetRequestId: string) => {
    try {
      await unlinkPlayer(targetRequestId);
      toast.success(t('intakeRequests.links.unlinked', { defaultValue: 'Player unlinked' }));
      onLinkChanged?.();
    } catch (error: any) {
      toast.error(error.message);
    }
  };

  const getDayLabel = (day: string) => {
    return t(`application.form.days.${day}`);
  };

  const formatTimeWindow = (window: { start: string; end: string }) => {
    return `${window.start} - ${window.end}`;
  };

  if (!request) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{t('intakeRequests.detail.title')}</SheetTitle>
          <SheetDescription>
            Applied {format(new Date(request.created_at), 'MMM d, yyyy')}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {/* Contact Info */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <User className="h-4 w-4" />
                {t('intakeRequests.detail.contactInfo')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <User className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">{request.full_name}</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span>{request.email}</span>
              </div>
              {request.phone && (
                <div className="flex items-center gap-2 text-sm">
                  <Phone className="h-4 w-4 text-muted-foreground" />
                  <span>{request.phone}</span>
                </div>
              )}
              {request.rating && (
                <div className="flex items-center gap-2 text-sm">
                  <Star className="h-4 w-4 text-muted-foreground" />
                  <span>{request.rating} ({request.rating_system})</span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Preferences */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Calendar className="h-4 w-4" />
                {t('intakeRequests.detail.preferences')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <span className="text-sm text-muted-foreground">Lesson type</span>
                <div className="flex flex-wrap gap-1">
                  {(Array.isArray(request.lesson_type) ? request.lesson_type : [request.lesson_type]).map((type: string) => (
                    <Badge key={type} variant="secondary">
                      {['private','duo','group3','group4','kids'].includes(type)
                        ? t(`application.form.lessonTypes.${type}`)
                        : type.charAt(0).toUpperCase() + type.slice(1)}
                    </Badge>
                  ))}
                </div>
              </div>
              {request.preferred_duration_minutes && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Duration</span>
                  <span className="text-sm font-medium">{request.preferred_duration_minutes} min</span>
                </div>
              )}
              {request.sessions_per_week && request.sessions_per_week > 1 && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{t('application.form.sessionsPerWeek')}</span>
                  <Badge variant="secondary">
                    {request.sessions_per_week}× {t('application.form.timesPerWeek')}
                  </Badge>
                </div>
              )}
              {request.metadata?.preferred_number_of_weeks && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{t('application.form.preferredWeeks', 'Preferred duration')}</span>
                  <Badge variant="secondary">
                    {String(request.metadata.preferred_number_of_weeks)} {t('application.form.weeks', 'weken')}
                  </Badge>
                </div>
              )}
              {request.location_id && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Location</span>
                  <span className="text-sm font-medium flex items-center gap-1">
                    <MapPin className="h-3.5 w-3.5" />
                    Specified
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Availability */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Clock className="h-4 w-4" />
                {t('intakeRequests.detail.availability')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {(() => {
                const timeWindows = (request.preferred_time_windows || []) as Array<{ day?: string; start?: string; end?: string }>;
                const windowsByDay = new Map<string, Array<{ start: string; end: string }>>();
                timeWindows.forEach(tw => {
                  if (tw.day) {
                    const existing = windowsByDay.get(tw.day) || [];
                    if (tw.start && tw.end) existing.push({ start: tw.start, end: tw.end });
                    windowsByDay.set(tw.day, existing);
                  }
                });
                const allDays = request.preferred_days || [];
                if (allDays.length === 0 && windowsByDay.size === 0) {
                  return <span className="text-sm text-muted-foreground">—</span>;
                }
                // Merge: show all days from preferred_days + any extra days from windows
                const dayOrder = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
                const uniqueDays = [...new Set([...allDays, ...windowsByDay.keys()])].sort(
                  (a, b) => dayOrder.indexOf(a) - dayOrder.indexOf(b)
                );
                return uniqueDays.map(day => {
                  const windows = windowsByDay.get(day) || [];
                  return (
                    <div key={day} className="flex items-start gap-2">
                      <span className="text-sm font-medium min-w-[90px]">{getDayLabel(day)}</span>
                      <div className="flex flex-wrap gap-1">
                        {windows.length > 0 ? windows.map((w, i) => (
                          <Badge key={i} variant="secondary" className="text-xs">
                            <Clock3 className="h-3 w-3 mr-1" />
                            {w.start} - {w.end}
                          </Badge>
                        )) : (
                          <Badge variant="outline" className="text-xs text-muted-foreground">
                            {t('intakeRequests.detail.wholeDay', { defaultValue: 'Whole day' })}
                          </Badge>
                        )}
                      </div>
                    </div>
                  );
                });
              })()}
            </CardContent>
          </Card>

          {/* Notes */}
          {request.notes && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  {t('intakeRequests.detail.notes')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                  {request.notes}
                </p>
              </CardContent>
            </Card>
          )}

          {/* Suggested Links from Notes */}
          {suggestedLinks.length > 0 && (
            <Card className="border-accent bg-accent/10">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium flex items-center gap-2 text-accent-foreground">
                  <Lightbulb className="h-4 w-4" />
                  {t('intakeRequests.links.suggestedLinks', { defaultValue: 'Voorgestelde koppelingen' })}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs text-muted-foreground mb-2">
                  {t('intakeRequests.links.suggestedLinksDescription', { defaultValue: 'Op basis van de notities van deze speler' })}
                </p>
                <div className="flex flex-wrap gap-2">
                  {suggestedLinks.map(sl => (
                    <Badge key={sl.id} variant="outline" className="flex items-center gap-1 pr-1">
                      <span>{sl.full_name}</span>
                      <button
                        onClick={() => handleLinkPlayer(sl.id)}
                        disabled={isLinking}
                        className="ml-1 rounded-full hover:bg-accent p-0.5"
                      >
                        <Plus className="h-3 w-3" />
                      </button>
                      <button
                        onClick={() => {
                          dismissSuggestion(request!.id, sl.id);
                          setDismissVersion(v => v + 1);
                        }}
                        className="rounded-full hover:bg-destructive/20 p-0.5"
                        title={t('intakeRequests.links.dismissSuggestion', { defaultValue: 'Dismiss suggestion' })}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
                {suggestedLinks.length > 1 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs mt-1"
                    disabled={isLinking}
                    onClick={async () => {
                      setIsLinking(true);
                      try {
                        const suggestedIds = suggestedLinks.map(s => s.id);
                        const allIds = [request.id, ...linkedRequestIds, ...suggestedIds];
                        await linkPlayers([...new Set(allIds)]);
                        setOptimisticLinkedIds(prev => [...prev, ...suggestedIds]);
                        toast.success(t('intakeRequests.links.linked', { defaultValue: 'Players linked' }));
                        onLinkChanged?.();
                      } catch (error: any) {
                        toast.error(error.message);
                      } finally {
                        setIsLinking(false);
                      }
                    }}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    {t('intakeRequests.links.linkAll', { defaultValue: 'Allemaal koppelen' })}
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          {/* Linked Players */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Link2 className="h-4 w-4" />
                {t('intakeRequests.links.linkedPlayers', { defaultValue: 'Samen trainen' })}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {linkedRequests.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {linkedRequests.map(lr => (
                    <Badge key={lr.id} variant="secondary" className="flex items-center gap-1 pr-1">
                      <span>{lr.full_name}</span>
                      <button
                        onClick={() => handleUnlinkPlayer(lr.id)}
                        className="ml-1 rounded-full hover:bg-muted p-0.5"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t('intakeRequests.links.noLinks', { defaultValue: 'Geen gekoppelde spelers' })}
                </p>
              )}

              <Popover open={linkPopoverOpen} onOpenChange={setLinkPopoverOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 text-xs" disabled={isLinking || availableToLink.length === 0}>
                    <Plus className="h-3 w-3 mr-1" />
                    {t('intakeRequests.links.addLink', { defaultValue: 'Koppelen' })}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="p-0 w-[280px]" align="start">
                  <Command>
                    <CommandInput placeholder={t('intakeRequests.links.searchPlayer', { defaultValue: 'Zoek speler...' })} />
                    <CommandList>
                      <CommandEmpty>{t('intakeRequests.links.noResults', { defaultValue: 'Geen spelers gevonden' })}</CommandEmpty>
                      <CommandGroup>
                        {availableToLink.map(r => (
                          <CommandItem
                            key={r.id}
                            value={r.full_name}
                            onSelect={() => handleLinkPlayer(r.id)}
                          >
                            <div className="flex flex-col">
                              <span className="text-sm font-medium">{r.full_name}</span>
                              <span className="text-xs text-muted-foreground">{r.email}</span>
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </CardContent>
          </Card>

          <Separator />

          {/* Proposal Section */}
          <div>
            <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              {t('intakeRequests.detail.proposal')}
            </h3>
            
            {isLoadingProposal ? (
              <Card className="animate-pulse">
                <CardContent className="h-32" />
              </Card>
            ) : proposal ? (
              <ProposalCard 
                proposal={proposal} 
                cycleId={cycleId}
                playerName={request.full_name}
                onStatusChange={onStatusChange}
              />
            ) : request.skip_reason ? (
              <Card className="border-yellow-500/30 bg-yellow-500/5">
                <CardContent className="py-4">
                  <div className="flex items-center gap-2 text-yellow-600 mb-2">
                    <AlertCircle className="h-5 w-5" />
                    <span className="font-medium">
                      {t(`skipReasons.${request.skip_reason}.title`)}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t(`skipReasons.${request.skip_reason}.description`)}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <Card className="border-dashed">
                <CardContent className="py-8 text-center">
                  <p className="text-sm text-muted-foreground">
                    {t('intakeRequests.detail.noProposal')}
                  </p>
                </CardContent>
              </Card>
            )}
          </div>

          <Separator />

          {/* Actions */}
          <div className="flex flex-wrap gap-2">
            <Button 
              variant="outline" 
              size="sm"
              onClick={() => setShowEditDialog(true)}
            >
              <Pencil className="h-4 w-4 mr-1" />
              {t('intakeRequests.actions.edit', { defaultValue: 'Bewerken' })}
            </Button>
            {request.status !== 'confirmed' && (
              <Button 
                size="sm" 
                onClick={() => handleStatusChange('confirmed')}
                disabled={isUpdating}
              >
                <CheckCircle2 className="h-4 w-4 mr-1" />
                {t('intakeRequests.actions.confirm')}
              </Button>
            )}
            {request.status !== 'waitlist' && (
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => handleStatusChange('waitlist')}
                disabled={isUpdating}
              >
                <Clock3 className="h-4 w-4 mr-1" />
                {t('intakeRequests.actions.waitlist')}
              </Button>
            )}
            {request.status !== 'rejected' && (
              <Button 
                variant="outline" 
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => handleStatusChange('rejected')}
                disabled={isUpdating}
              >
                <XCircle className="h-4 w-4 mr-1" />
                {t('intakeRequests.actions.reject')}
              </Button>
            )}

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button 
                  variant="destructive" 
                  size="sm"
                  className="ml-auto"
                  disabled={isDeleting}
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  {t('intakeRequests.actions.delete')}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('intakeRequests.delete.title')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('intakeRequests.delete.description')}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('intakeRequests.delete.cancel')}</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDelete} disabled={isDeleting}>
                    {t('intakeRequests.delete.confirm')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        {/* Edit Dialog */}
        {request && (
          <EditIntakeRequestDialog
            open={showEditDialog}
            onOpenChange={setShowEditDialog}
            request={request}
            onSuccess={() => {
              onStatusChange?.();
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
