import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ArrowLeft, Globe, EyeOff, Mail, MailCheck, Send, CheckCircle2, Clock, XCircle, ChevronRight, ChevronDown, Search, Copy, MailX, UserMinus, UserPlus, CreditCard, Plus, Pencil, AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmailMessageField } from '@/components/email/EmailMessageField';
import { Skeleton } from '@/components/ui/skeleton';
import { SelectFilter } from '@/components/ui/select-filter';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DataTableCard, compactDataTableClass } from '@/components/ui/data-table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import {
  getCycleRebookStatus, bulkReleaseToPublic, bulkHoldSlots, sendRebookReminder,
  rebookPlayerOutcome, clickedYesUnpaid, freePlayerRebookSeat, reinstateRebookPlayer,
  type GroupStatus, type RebookManageGroup, type RebookManagePlayer, type RebookReminderTarget,
} from '@/lib/rebookManage';
import { drainRebookRoundInvites } from '@/lib/rebookInviteSend';
import { personKeyOf } from '@/lib/personIdentity';
import { formatCurrency } from '@/lib/format';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { RebookRoundTextsDialog } from '@/components/cycles/RebookRoundTextsDialog';
import { RebookDeadlineDialog } from '@/components/cycles/RebookDeadlineDialog';
import { RebookRoundBillingDialog } from '@/components/cycles/RebookRoundBillingDialog';
import { RebookReleasePolicyDialog } from '@/components/cycles/RebookReleasePolicyDialog';
import type { CycleBookingMode } from '@/lib/cycleBookingMode';

// Map the round's public open-up booking mode to the shared (trainer-namespace) label keys.
const PUBLIC_OPEN_MODE_KEY: Record<CycleBookingMode, string> = {
  both: 'cyclesTab.bulkBooking.modeBoth',
  single_only: 'cyclesTab.bulkBooking.modeSingleOnly',
  single_only_whole_slot: 'cyclesTab.bulkBooking.modeSingleOnlyWholeSlot',
  cyclus_only: 'cyclesTab.bulkBooking.modeCyclusOnly',
};

const STATUS_STYLE: Record<GroupStatus, string> = {
  rebooked: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  awaiting: 'bg-amber-100 text-amber-800 border-amber-200',
  declined: 'bg-rose-100 text-rose-800 border-rose-200',
  members: 'bg-sky-100 text-sky-800 border-sky-200',
  public: 'bg-slate-100 text-slate-700 border-slate-200',
};
const STATUS_ORDER: GroupStatus[] = ['rebooked', 'awaiting', 'declined', 'members', 'public'];

type PaymentFilter = 'all' | 'unpaid' | 'paid';

const claimedOf = (g: RebookManageGroup) => g.players.filter((p) => p.response === 'claimed');

/** Server caps the reminder message at 2000 chars (send-rebook-reminder); mirror it here. */
const REMINDER_MESSAGE_MAX = 2000;
const fmtReminded = (iso: string) => new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });

export default function AcademyRebookManage() {
  const { cycleId } = useParams<{ cycleId: string }>();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation('cycles');
  const { activeAcademy } = useAcademyContext();
  // Round texts editor (claim-page explanation + emails + rules, saved round-wide).
  const [textsOpen, setTextsOpen] = useState(false);
  // Round deadline editor (priority_window_ends_at, saved round-wide, academy timezone).
  const [deadlineOpen, setDeadlineOpen] = useState(false);
  const [billingOpen, setBillingOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const academyTimezone = activeAcademy?.timezone || 'Europe/Amsterdam';

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['rebook-manage', cycleId],
    queryFn: () => getCycleRebookStatus(cycleId!),
    enabled: !!cycleId,
  });

  // Filters
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | GroupStatus>('all');
  const [paymentFilter, setPaymentFilter] = useState<PaymentFilter>('all');
  const [trainerFilter, setTrainerFilter] = useState<string>('all');
  const [locationFilter, setLocationFilter] = useState<string>('all');
  // Toggled via the "klikte Ja, niet afgerond" summary chunk: show ONLY the players who clicked
  // Yes but never completed payment (pending or lapsed) — the second-chance follow-up list.
  const [clickedYesOnly, setClickedYesOnly] = useState(false);

  // Selection + UI state
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [selectedPlayers, setSelectedPlayers] = useState<Map<string, RebookReminderTarget>>(new Map());
  const [busy, setBusy] = useState(false);
  // Resumable invite drain ({ sent, total }) for the "send un-sent invitations" recovery.
  const [sendProgress, setSendProgress] = useState<{ sent: number; total: number } | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');

  const statusLabel = (s: GroupStatus) => t(`rebookManage.status.${s}`, {
    rebooked: 'Geherboekt', awaiting: 'Wacht op reactie', declined: 'Niet geherboekt',
    members: 'Open voor vaste spelers', public: 'Open voor iedereen',
  }[s]);

  const groups = useMemo(() => data?.groups ?? [], [data]);

  const trainerOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups) if (g.trainerId) m.set(g.trainerId, g.trainerName || g.trainerId);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], 'nl'));
  }, [groups]);
  const locationOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups) if (g.locationId) m.set(g.locationId, g.locationName || g.locationId);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], 'nl'));
  }, [groups]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return groups.filter((g) => {
      if (statusFilter !== 'all' && g.status !== statusFilter) return false;
      if (trainerFilter !== 'all' && g.trainerId !== trainerFilter) return false;
      if (locationFilter !== 'all' && g.locationId !== locationFilter) return false;
      if (clickedYesOnly && !g.players.some(clickedYesUnpaid)) return false;
      if (paymentFilter !== 'all') {
        const claimed = claimedOf(g);
        if (paymentFilter === 'unpaid' && !claimed.some((p) => !p.paid)) return false;
        if (paymentFilter === 'paid' && !(claimed.length > 0 && claimed.every((p) => p.paid))) return false;
      }
      if (q) {
        const hay = `${g.weekday} ${g.time} ${g.trainerName ?? ''} ${g.locationName ?? ''} ${g.players.map((p) => p.name).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [groups, search, statusFilter, paymentFilter, trainerFilter, locationFilter, clickedYesOnly]);

  const toggleExpanded = (id: string) => setExpanded((prev) => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const toggleGroup = (id: string) => setSelectedGroups((prev) => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const togglePlayer = (key: string, target: RebookReminderTarget) => setSelectedPlayers((prev) => {
    const n = new Map(prev);
    if (n.has(key)) n.delete(key); else n.set(key, target);
    return n;
  });

  const allFilteredSelected = filtered.length > 0 && filtered.every((g) => selectedGroups.has(g.groupId));
  const toggleSelectAll = () => setSelectedGroups((prev) => {
    const n = new Set(prev);
    if (allFilteredSelected) filtered.forEach((g) => n.delete(g.groupId));
    else filtered.forEach((g) => n.add(g.groupId));
    return n;
  });

  const selectedSlotIds = useMemo(() => {
    return groups.filter((g) => selectedGroups.has(g.groupId)).flatMap((g) => g.slotIds);
  }, [groups, selectedGroups]);

  const clearSelection = () => { setSelectedGroups(new Set()); setSelectedPlayers(new Map()); };

  // A genuine non-responder: still pending AND has not clicked "No" on the invite. Someone who
  // clicked No (decline intent) or already rebooked must not be swept into a "please confirm" blast.
  const isNonResponder = (p: RebookManageGroup['players'][number]) =>
    p.response === 'pending' && p.responseIntent !== 'decline';

  // Select every still-awaiting (non-responder) player within the current filters — the
  // common reminder case; individual chip selection keeps it fully flexible for other cases.
  const selectNonResponders = () => setSelectedPlayers((prev) => {
    const n = new Map(prev);
    for (const g of filtered) for (const p of g.players) {
      if (isNonResponder(p)) n.set(p.key, { player_id: p.playerId, guest_player_id: p.guestPlayerId });
    }
    return n;
  });
  // Count DISTINCT non-responders (by identity), matching what selectNonResponders actually adds:
  // a player enrolled in two weekly series appears in two groups but is one selection.
  const pendingInFilter = useMemo(() => {
    const keys = new Set<string>();
    for (const g of filtered) for (const p of g.players) if (isNonResponder(p)) keys.add(p.key);
    return keys.size;
  }, [filtered]);

  // Awareness for "don't double-nudge": how many selected were already reminded, and how many
  // have ALREADY REBOOKED (sending them a "please confirm" nudge on a mass send reads badly).
  const remindedKeys = useMemo(() => {
    const s = new Set<string>();
    for (const g of groups) for (const p of g.players) if (p.lastRemindedAt) s.add(p.key);
    return s;
  }, [groups]);
  const rebookedKeys = useMemo(() => {
    const s = new Set<string>();
    for (const g of groups) for (const p of g.players) if (rebookPlayerOutcome(p) === 'rebooked') s.add(p.key);
    return s;
  }, [groups]);
  const selectedAlreadyReminded = useMemo(
    () => [...selectedPlayers.keys()].filter((k) => remindedKeys.has(k)).length,
    [selectedPlayers, remindedKeys],
  );
  const selectedAlreadyRebooked = useMemo(
    () => [...selectedPlayers.keys()].filter((k) => rebookedKeys.has(k)).length,
    [selectedPlayers, rebookedKeys],
  );

  const runBulk = async (fn: (ids: string[]) => ReturnType<typeof bulkReleaseToPublic>, doneKey: string, fallback: string) => {
    if (selectedSlotIds.length === 0) return;
    setBusy(true);
    try {
      const res = await fn(selectedSlotIds);
      if (res.failed.length > 0) {
        toast.error(t('rebookManage.bulkPartial', '{{ok}} gelukt, {{fail}} mislukt', { ok: res.succeeded, fail: res.failed.length }));
      } else {
        toast.success(t(doneKey, fallback, { count: res.succeeded }));
      }
      clearSelection();
      refetch();
    } finally { setBusy(false); }
  };

  const onSendReminder = async () => {
    if (!cycleId || selectedPlayers.size === 0 || !subject.trim() || !message.trim()) return;
    setBusy(true);
    try {
      const res = await sendRebookReminder({
        cycleId,
        targets: [...selectedPlayers.values()],
        subject: subject.trim(),
        message: message.trim(),
      });
      refetch(); // refresh "last reminded" chips + already-reminded counts so we don't double-nudge
      if (!res.ok || res.failed > 0) {
        // Any non-clean outcome (a send failure OR a config/edge failure with no precise retry set,
        // e.g. email_not_configured — Codex round-8 #3). Keep ONLY the failed identities selected + the
        // composed text + the dialog open, so the manager can retry exactly them — never a false
        // success, never asking them to reconstruct an unknowable remainder or clearing unprocessed
        // work (Codex round-7 #2).
        const retry = new Map<string, RebookReminderTarget>();
        for (const target of res.failedTargets) { const k = personKeyOf(target); if (k) retry.set(k, target); }
        setSelectedGroups(new Set());
        setSelectedPlayers(retry);
        toast.error(t('rebookManage.reminderRetryFailed', '{{sent}} verstuurd, {{failed}} mislukt — de mislukte staan nog geselecteerd, probeer opnieuw.', { sent: res.sent, failed: res.failed }));
        return; // keep the compose dialog + subject/message for the retry
      }
      if (res.skipped > 0) {
        toast.success(t('rebookManage.reminderPartial', '{{sent}} verstuurd, {{skip}} overgeslagen', { sent: res.sent, skip: res.skipped }));
      } else {
        toast.success(t('rebookManage.reminderDone', '{{sent}} herinneringen verstuurd', { sent: res.sent }));
      }
      setComposeOpen(false); setSubject(''); setMessage(''); clearSelection();
    } finally { setBusy(false); }
  };

  // Finish sending the round's INITIAL invites (recovery for a first blast that was
  // interrupted / partially sent). Idempotent + resumable: only un-invited players
  // are emailed, so this never double-sends. NOT a reminder — it's the first invite.
  const onResumeInvites = async () => {
    if (!cycleId || busy || sendProgress) return;
    const total = data?.uninvitedCount ?? 0;
    if (total <= 0) return;
    setSendProgress({ sent: 0, total });
    try {
      // Round-scoped: a per-series round has one cycle PER SERIES, and the un-sent invites can live on
      // ANY sibling cycle. Draining only the route cycleId would find its own reps already invited and
      // send 0 while the UI still shows N unsent (stranded on siblings). Drain across ALL round cycles,
      // exactly as the initial-blast wizard does.
      const res = await drainRebookRoundInvites(data?.cycleIds ?? [cycleId], {
        onProgress: ({ totalSent, total: sendable }) => setSendProgress({ sent: totalSent, total: sendable || total }),
      });
      if (res.stoppedReason === 'error' && res.totalSent === 0) {
        toast.error(t('rebookManage.resumeFailed', 'Kon de uitnodigingen niet versturen. Probeer het later opnieuw.'));
      } else if (res.leftover > 0) {
        toast.warning(t('rebookManage.resumePartial', '{{sent}} uitnodiging(en) verstuurd, {{left}} nog open. Probeer de rest zo opnieuw.', { sent: res.totalSent, left: res.leftover }));
      } else {
        toast.success(t('rebookManage.resumeDone', '{{sent}} uitnodiging(en) verstuurd', { sent: res.totalSent }));
      }
      refetch();
    } finally { setSendProgress(null); }
  };

  // "Free the seat": the invitee isn't coming back — cancel their booking(s) on this series
  // and decline their claim(s) so the spot re-opens. Confirmed via dialog (warns on paid).
  const [freeTarget, setFreeTarget] = useState<{ group: RebookManageGroup; player: RebookManagePlayer } | null>(null);
  const confirmFreeSeat = async () => {
    if (!freeTarget) return;
    const { group, player } = freeTarget;
    setBusy(true);
    try {
      const res = await freePlayerRebookSeat({
        slotIds: group.slotIds,
        player: { playerId: player.playerId, guestPlayerId: player.guestPlayerId },
        claimIds: player.claimIds,
      });
      if (res.cancelError) {
        toast.error(t('rebookManage.freeSeatFailed', 'Kon de plek niet vrijgeven. Probeer het opnieuw.'));
      } else {
        toast.success(t('rebookManage.freeSeatDone', 'Plek vrijgegeven voor {{name}}', { name: player.name }));
      }
      setFreeTarget(null);
      refetch();
    } finally { setBusy(false); }
  };

  // "Reinstate": the invitee accidentally said no — put them back. Re-books their whole series,
  // COVERED (paid) when the group paid the full court, else unpaid. Confirmed via dialog.
  const [reinstateTarget, setReinstateTarget] = useState<{ group: RebookManageGroup; player: RebookManagePlayer } | null>(null);
  const confirmReinstate = async () => {
    if (!reinstateTarget) return;
    const { player } = reinstateTarget;
    setBusy(true);
    try {
      const res = await reinstateRebookPlayer({ claimIds: player.claimIds });
      if (res.error) {
        toast.error(t('rebookManage.reinstateFailed', 'Kon de speler niet terugzetten. Probeer het opnieuw.'));
      } else if (res.reinstated === 0 && res.reinstatedUnpaid === 0 && res.alreadyActive === 0 && res.seatFull > 0) {
        toast.error(t('rebookManage.reinstateSeatFull', 'De plek was inmiddels bezet — {{name}} kon niet worden teruggezet.', { name: player.name }));
      } else {
        toast.success(t('rebookManage.reinstateDone', '{{name}} staat weer op de lijst', { name: player.name }));
        if (res.reinstatedUnpaid > 0) {
          toast.warning(t('rebookManage.reinstateUnpaidNote', 'Let op: {{name}} moet nog betalen — deel de betaallink.', { name: player.name }));
        }
        if (res.seatFull > 0) {
          toast.warning(t('rebookManage.reinstatePartialFull', '{{count}} sessie(s) waren vol en zijn overgeslagen.', { count: res.seatFull }));
        }
      }
      setReinstateTarget(null);
      refetch();
    } finally { setBusy(false); }
  };

  if (isLoading) {
    return <div className="p-4 space-y-3"><Skeleton className="h-8 w-64" /><Skeleton className="h-40 w-full" /></div>;
  }

  // Codex round-5 #2: getCycleRebookStatus now fails loud on any read error (claims, invoices,
  // contacts, …). Render an explicit, retryable error state instead of an empty/mislabelled page —
  // an empty round or an "everyone unpaid" table would silently misinform the manager.
  if (isError) {
    return (
      <div className="p-4 max-w-6xl mx-auto">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/app/academy/cycles/${cycleId}`)}>
          <ArrowLeft className="h-4 w-4 mr-1" /> {t('common:back', 'Terug')}
        </Button>
        <div className="mt-8 flex flex-col items-center justify-center gap-4 text-center">
          <AlertTriangle className="h-10 w-10 text-destructive" />
          <div>
            <p className="font-medium">{t('rebookManage.loadFailedTitle', 'Kon de herboeking niet laden')}</p>
            <p className="text-sm text-muted-foreground mt-1">
              {t('rebookManage.loadFailedBody', 'Er ging iets mis bij het ophalen van de gegevens. Probeer het opnieuw.')}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 mr-1${isFetching ? ' animate-spin' : ''}`} /> {t('common:queryError.retry', 'Opnieuw proberen')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4 max-w-6xl mx-auto">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/app/academy/cycles/${cycleId}`)}>
          <ArrowLeft className="h-4 w-4 mr-1" /> {t('common:back', 'Terug')}
        </Button>
        <h1 className="text-lg font-semibold truncate">
          {t('rebookManage.title', 'Herboeking beheren')}{data?.cycleName ? ` — ${data.cycleName}` : ''}
        </h1>
        {/* Round-wide actions (need settings.rebook_round_id — legacy single-cycle rounds lack it):
            edit the round's texts (claim page + emails + rules) and extend the round with groups
            that were left out of (or failed during) the original send. */}
        {data?.roundId && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {activeAcademy && (
              <Button variant="outline" size="sm" onClick={() => setTextsOpen(true)}>
                <Pencil className="h-4 w-4 mr-1" /> {t('rebookManage.editTexts', 'Teksten bewerken')}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(`/app/academy/cycles/rebook?extendRound=${data.roundId}`)}
            >
              <Plus className="h-4 w-4 mr-1" /> {t('rebookManage.addGroups', 'Groepen toevoegen')}
            </Button>
          </div>
        )}
      </div>

      {data?.roundId && activeAcademy && (
        <RebookRoundTextsDialog
          open={textsOpen}
          onOpenChange={setTextsOpen}
          academyProfileId={activeAcademy.id}
          roundId={data.roundId}
          onSaved={() => refetch()}
        />
      )}

      {/* Round settings at a glance — WHEN it closes, HOW it's paid, WHAT happens after the
          deadline. One compact three-cell strip instead of stacked rows; each cell edits
          round-wide via its pencil. Not gated on roundId: legacy rounds have these too. */}
      {data && (
        <div className="grid gap-x-6 gap-y-3 rounded-lg border px-4 py-2.5 sm:grid-cols-3" data-testid="rebook-settings-strip">
          <div data-testid="rebook-deadline-row">
            <div className="text-xs text-muted-foreground">{t('rebookManage.settingsDeadline', 'Reactietermijn')}</div>
            <div className="flex items-center gap-1 text-sm font-medium">
              {data.priorityDeadline.deadline
                ? new Intl.DateTimeFormat(i18n.language === 'en' ? 'en-GB' : 'nl-NL', {
                    timeZone: academyTimezone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
                  }).format(new Date(data.priorityDeadline.deadline))
                : '—'}
              <Button
                variant="ghost" size="sm" className="h-6 w-6 p-0"
                onClick={() => setDeadlineOpen(true)}
                aria-label={t('rebookManage.editDeadline', 'Reactietermijn aanpassen')}
                title={t('rebookManage.editDeadline', 'Reactietermijn aanpassen')}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </div>
            {data.priorityDeadline.varies && (
              <div className="text-xs text-muted-foreground">{t('rebookManage.deadlineVaries', 'verschilt per groep — dit is de laatste')}</div>
            )}
          </div>

          {activeAcademy && (
            <div data-testid="rebook-billing-row">
              <div className="text-xs text-muted-foreground">{t('rebookManage.settingsBilling', 'Betaling')}</div>
              <div className="flex items-center gap-1 text-sm font-medium">
                {data.paymentMode === 'upfront' ? t('rebookManage.payUpfrontShort', 'direct betalen') : t('rebookManage.payDeferredShort', 'factuur bij start (split)')}
                <Button
                  variant="ghost" size="sm" className="h-6 w-6 p-0"
                  onClick={() => setBillingOpen(true)}
                  aria-label={t('rebookManage.editBilling', 'Betaling aanpassen')}
                  title={t('rebookManage.editBilling', 'Betaling aanpassen')}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="text-xs text-muted-foreground">
                {t('rebookManage.payPublicShort', 'publiek:')}{' '}
                {t(PUBLIC_OPEN_MODE_KEY[data.publicOpenMode], { ns: 'trainer' })}
                {data.publicOpenSplit ? ' · ' + t('rebookManage.paySplitShort', 'gesplitst') : ''}
              </div>
            </div>
          )}

          <div data-testid="rebook-release-row">
            <div className="text-xs text-muted-foreground">{t('rebookManage.settingsAfterDeadline', 'Na de deadline')}</div>
            <div className="flex items-center gap-1 text-sm font-medium">
              {data.releasePolicy === 'auto'
                ? t('rebookManage.releaseValAuto', 'gaat automatisch open')
                : data.releasePolicy === 'private'
                  ? t('rebookManage.releaseValPrivate', 'blijft privé')
                  : t('rebookManage.releaseValMixed', 'gemengd')}
              <Button
                variant="ghost" size="sm" className="h-6 w-6 p-0"
                onClick={() => setReleaseOpen(true)}
                aria-label={t('rebookManage.releaseTitle', 'Publiek vrijgeven')}
                title={t('rebookManage.releaseTitle', 'Publiek vrijgeven')}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="text-xs text-muted-foreground">
              {data.releasePolicy === 'private'
                ? t('rebookManage.releaseValPrivateHint', 'tot je vrije plekken zelf vrijgeeft')
                : t('rebookManage.releaseValAutoHint', 'vrije plekken worden publiek boekbaar')}
            </div>
          </div>
        </div>
      )}

      {data && (
        <RebookDeadlineDialog
          open={deadlineOpen}
          onOpenChange={setDeadlineOpen}
          cycleIds={data.cycleIds}
          currentDeadline={data.priorityDeadline.deadline}
          timezone={academyTimezone}
          onSaved={() => refetch()}
        />
      )}

      {data && activeAcademy && (
        <RebookRoundBillingDialog
          open={billingOpen}
          onOpenChange={setBillingOpen}
          cycleIds={data.cycleIds}
          academyProfileId={activeAcademy.id}
          currentPaymentMode={data.paymentMode}
          currentStrictMollie={data.strictMollie}
          currentPublicOpenMode={data.publicOpenMode}
          currentPublicOpenSplit={data.publicOpenSplit}
          onSaved={() => refetch()}
        />
      )}

      {data && (
        <RebookReleasePolicyDialog
          open={releaseOpen}
          onOpenChange={setReleaseOpen}
          cycleIds={data.cycleIds}
          currentPolicy={data.releasePolicy}
          onSaved={() => refetch()}
        />
      )}

      {/* Per-invitee headline — the owner's "who rebooked / who said no / who's silent". */}
      {data && data.summary.invited > 0 && (
        <p className="text-sm text-muted-foreground" data-testid="rebook-outcome-summary">
          <span className="font-semibold text-foreground">{data.summary.invited}</span> {t('rebookManage.summary.invited', 'uitgenodigd')}
          {' · '}<span className="font-semibold text-emerald-700">{data.summary.rebooked}</span> {t('rebookManage.summary.rebooked', 'geherboekt')}
          {' · '}<span className="font-semibold text-rose-700">{data.summary.declined}</span> {t('rebookManage.summary.declined', 'geweigerd')}
          {' · '}<span className="font-semibold text-amber-700">{data.summary.noResponse}</span> {t('rebookManage.summary.noResponse', 'geen reactie')}
          {data.summary.clickedYesUnpaid > 0 && (
            <>
              {' · '}
              {/* Clickable (like the status badges below): toggles the table down to ONLY these
                  players — the second-chance follow-up list the owner wants to find fast. */}
              <button
                type="button"
                aria-pressed={clickedYesOnly}
                onClick={() => setClickedYesOnly((v) => !v)}
                title={t('rebookManage.clickedYesFilterHint', 'Filter de tabel op deze spelers')}
                className={`inline-flex items-baseline gap-1 rounded px-1 -mx-0.5 text-amber-700 underline decoration-dotted underline-offset-2 hover:bg-amber-50 ${clickedYesOnly ? 'bg-amber-100 ring-1 ring-amber-300' : ''}`}
              >
                <span className="font-semibold">{data.summary.clickedYesUnpaid}</span>{' '}
                {t('rebookManage.summary.clickedYesUnpaid', 'klikte Ja, niet afgerond')}
              </button>
            </>
          )}
          {/* Invite delivery folded into the same line (was its own row) — saves vertical space. */}
          {data.invitesTotal > 0 && (
            <>
              {' · '}
              <span className="inline-flex items-center gap-1 whitespace-nowrap align-text-bottom">
                <MailCheck className="h-4 w-4" />
                {t('rebookManage.invitesSentShort', '{{sent}}/{{total}} verstuurd', { sent: data.invitesSent, total: data.invitesTotal })}
              </span>
            </>
          )}
        </p>
      )}

      {/* Un-sent invites recovery: finish a first blast that was interrupted or
          partially sent. Idempotent drain — never re-emails an already-invited player. */}
      {data && (data.uninvitedCount > 0 || sendProgress) && (
        <div className="flex flex-col gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 sm:flex-row sm:items-center sm:justify-between" data-testid="rebook-resume-invites">
          <p className="text-sm text-amber-900">
            {t('rebookManage.uninvited', '{{count}} uitnodiging(en) zijn nog niet verstuurd.', { count: data.uninvitedCount })}
          </p>
          <Button size="sm" onClick={onResumeInvites} disabled={busy || !!sendProgress}>
            <Send className="h-4 w-4 mr-1" />
            {sendProgress
              ? t('rebookManage.sendingInvites', 'Versturen… {{sent}}/{{total}}', { sent: sendProgress.sent, total: sendProgress.total })
              : t('rebookManage.sendInvites', 'Uitnodigingen versturen')}
          </Button>
        </div>
      )}

      {/* Group lifecycle counts (per weekly series) */}
      <div className="flex flex-wrap gap-2">
        {STATUS_ORDER.map((s) => (
          <button key={s} type="button" aria-label={statusLabel(s)} onClick={() => setStatusFilter((cur) => (cur === s ? 'all' : s))}>
            <Badge variant="outline" className={`${STATUS_STYLE[s]} ${statusFilter === s ? 'ring-2 ring-offset-1 ring-primary/40' : ''}`}>
              {statusLabel(s)}: {data?.counts[s] ?? 0}
            </Badge>
          </button>
        ))}
        <Badge variant="outline" className="bg-emerald-100 text-emerald-800 border-emerald-200">
          {t('rebookManage.paid', 'Betaald')}: {data?.paidCount ?? 0}{data && data.paidAmount > 0 ? ` · ${formatCurrency(data.paidAmount)}` : ''}
        </Badge>
        <Badge variant="outline" className="bg-rose-100 text-rose-800 border-rose-200">
          {t('rebookManage.unpaid', 'Open')}: {data?.unpaidCount ?? 0}{data && data.outstandingAmount > 0 ? ` · ${formatCurrency(data.outstandingAmount)}` : ''}
        </Badge>
      </div>

      {/* Filter toolbar */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('rebookManage.searchPlaceholder', 'Zoek op speler, dag, trainer…')}
            className="pl-8"
          />
        </div>
        <SelectFilter
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as 'all' | GroupStatus)}
          allLabel={t('rebookManage.allStatuses', 'Alle statussen')}
          options={STATUS_ORDER.map((s) => ({ value: s, label: statusLabel(s) }))}
          triggerClassName="w-full sm:w-[180px]"
        />
        <SelectFilter
          value={paymentFilter}
          onValueChange={(v) => setPaymentFilter(v as PaymentFilter)}
          allLabel={t('rebookManage.allPayments', 'Alle betalingen')}
          options={[
            { value: 'unpaid', label: t('rebookManage.filterUnpaid', 'Heeft openstaand') },
            { value: 'paid', label: t('rebookManage.filterPaid', 'Volledig betaald') },
          ]}
          triggerClassName="w-full sm:w-[150px]"
        />
        {trainerOptions.length > 1 && (
          <SelectFilter
            value={trainerFilter}
            onValueChange={setTrainerFilter}
            allLabel={t('rebookManage.allTrainers', 'Alle trainers')}
            options={trainerOptions.map(([id, name]) => ({ value: id, label: name }))}
            triggerClassName="w-full sm:w-[160px]"
          />
        )}
        {locationOptions.length > 1 && (
          <SelectFilter
            value={locationFilter}
            onValueChange={setLocationFilter}
            allLabel={t('rebookManage.allLocations', 'Alle locaties')}
            options={locationOptions.map(([id, name]) => ({ value: id, label: name }))}
            triggerClassName="w-full sm:w-[160px]"
          />
        )}
      </div>

      {/* Quick-pick the non-responders for a reminder (respects the active filters) */}
      {pendingInFilter > 0 && (
        <div>
          <Button size="sm" variant="outline" onClick={selectNonResponders}>
            <Clock className="h-4 w-4 mr-1" />
            {t('rebookManage.selectNonResponders', 'Selecteer wachtenden ({{n}})', { n: pendingInFilter })}
          </Button>
        </div>
      )}

      {/* Bulk bar */}
      {(selectedGroups.size > 0 || selectedPlayers.size > 0) && (
        <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-md border bg-background p-2 shadow-sm">
          <span className="text-sm text-muted-foreground">
            {t('rebookManage.selected', '{{g}} sessies · {{p}} spelers', { g: selectedGroups.size, p: selectedPlayers.size })}
          </span>
          {/* R16: bulk release skips the member/second-bucket tier — confirm first (same
              consequence as the single-slot control). */}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="outline" disabled={busy || selectedSlotIds.length === 0}>
                <Globe className="h-4 w-4 mr-1" /> {t('rebookManage.openToPublic', 'Open voor iedereen')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('tierControl.openPublicConfirmTitle', 'Direct voor iedereen openzetten?')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('tierControl.openPublicConfirmBody', 'Hiermee sla je het venster voor vaste spelers over — spelers die al een sessie hadden en je voorrangslijst krijgen géén eerste keus.')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common:cancel', 'Annuleren')}</AlertDialogCancel>
                <AlertDialogAction onClick={() => runBulk(bulkReleaseToPublic, 'rebookManage.openedPublic', '{{count}} sessies opengezet')}>
                  {t('tierControl.openPublicConfirmAction', 'Ja, voor iedereen openzetten')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Button size="sm" variant="outline" disabled={busy || selectedSlotIds.length === 0}
            onClick={() => runBulk(bulkHoldSlots, 'rebookManage.madePrivate', '{{count}} sessies verborgen')}>
            <EyeOff className="h-4 w-4 mr-1" /> {t('rebookManage.makePrivate', 'Verbergen')}
          </Button>
          <Button size="sm" disabled={busy || selectedPlayers.size === 0}
            onClick={() => {
              // Pre-fill from the round's saved REMINDER text (falls back to the invite message).
              if (!message.trim()) setMessage(data?.reminderMessage || data?.invitationMessage || '');
              if (!subject.trim() && data?.reminderSubject) setSubject(data.reminderSubject);
              setComposeOpen(true);
            }}>
            <Mail className="h-4 w-4 mr-1" /> {t('rebookManage.emailReminder', 'Herinnering mailen')}
          </Button>
          <Button size="sm" variant="ghost" onClick={clearSelection}>{t('common:clear', 'Wissen')}</Button>
        </div>
      )}

      {/* Table — same compact density + card frame as the Players/overview tables. */}
      <DataTableCard desktopOnly={false}>
        <Table className={compactDataTableClass}>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead className="w-8">
                <Checkbox checked={allFilteredSelected} onCheckedChange={toggleSelectAll} aria-label="select all sessions" />
              </TableHead>
              <TableHead className="w-6" />
              <TableHead>{t('rebookManage.colSession', 'Sessie')}</TableHead>
              <TableHead className="hidden md:table-cell">{t('rebookManage.colTrainer', 'Trainer')}</TableHead>
              <TableHead className="hidden lg:table-cell">{t('rebookManage.colLocation', 'Locatie')}</TableHead>
              <TableHead>{t('rebookManage.colStatus', 'Status')}</TableHead>
              <TableHead className="text-right whitespace-nowrap">{t('rebookManage.colRebooked', 'Geherboekt')}</TableHead>
              <TableHead className="text-right whitespace-nowrap">{t('rebookManage.colPaid', 'Betaald')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                  {groups.length === 0
                    ? t('rebookManage.empty', 'Geen herboekingsgegevens voor deze cyclus.')
                    : t('rebookManage.noMatches', 'Geen sessies komen overeen met de filters.')}
                </TableCell>
              </TableRow>
            ) : filtered.map((g) => {
              const claimed = claimedOf(g);
              const rebooked = claimed.length;
              const paid = claimed.filter((p) => p.paid).length;
              // The clicked-yes filter is a PLAYER search: force groups open and narrow the
              // sub-rows to the matching players so the list reads as one flat follow-up list.
              const isOpen = expanded.has(g.groupId) || clickedYesOnly;
              return (
                <RebookRows
                  key={g.groupId}
                  g={g} isOpen={isOpen} rebooked={rebooked} paid={paid}
                  selected={selectedGroups.has(g.groupId)}
                  statusLabel={statusLabel}
                  onToggleSelect={() => toggleGroup(g.groupId)}
                  onToggleExpand={() => toggleExpanded(g.groupId)}
                  selectedPlayers={selectedPlayers}
                  onTogglePlayer={togglePlayer}
                  onFreeSeat={(p) => setFreeTarget({ group: g, player: p })}
                  onReinstate={(p) => setReinstateTarget({ group: g, player: p })}
                  playerFilter={clickedYesOnly ? clickedYesUnpaid : undefined}
                  t={t}
                />
              );
            })}
          </TableBody>
        </Table>
      </DataTableCard>
      {isFetching && <div className="text-xs text-muted-foreground">{t('common:loading', 'Bezig...')}</div>}

      <Dialog open={composeOpen} onOpenChange={(o) => { if (!o) setComposeOpen(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('rebookManage.composeTitle', 'Herinnering naar {{n}} spelers', { n: selectedPlayers.size })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>{t('rebookManage.composeSubject', 'Onderwerp')}</Label>
              <Input value={subject} maxLength={120} onChange={(e) => setSubject(e.target.value)}
                placeholder={t('rebookManage.composeSubjectPlaceholder', 'Herinnering: bevestig je plek')} />
            </div>
            <div className="space-y-1">
              <EmailMessageField
                id="rebook-reminder-message"
                value={message}
                onChange={setMessage}
                disabled={busy}
                maxLength={REMINDER_MESSAGE_MAX}
                label={t('rebookManage.composeMessage', 'Bericht')}
                placeholder={t('rebookManage.composeMessagePlaceholder', 'Korte herinnering aan je spelers…')}
                variablesHelp={t('rebookManage.composeVariablesHelp', 'Voeg variabele toe:')}
              />
              <p className="text-xs text-muted-foreground">{t('rebookManage.composeHint', 'We voegen je academienaam en een knop naar hun uitnodiging toe.')}</p>
              {selectedAlreadyReminded > 0 && (
                <p className="text-xs text-amber-600">
                  {t('rebookManage.alreadyReminded', '{{n}} van deze spelers zijn al eerder herinnerd.', { n: selectedAlreadyReminded })}
                </p>
              )}
              {selectedAlreadyRebooked > 0 && (
                <p className="text-xs text-rose-600" data-testid="reminder-rebooked-warning">
                  {t('rebookManage.alreadyRebookedWarning', '{{n}} van deze spelers hebben al geherboekt — zij krijgen ook deze herinnering.', { n: selectedAlreadyRebooked })}
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setComposeOpen(false)} disabled={busy}>{t('common:cancel', 'Annuleren')}</Button>
            <Button onClick={onSendReminder} disabled={busy || !subject.trim() || !message.trim()}>
              {busy ? t('common:loading', 'Bezig...') : t('rebookManage.composeSend', 'Versturen')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Free-a-seat confirm: cancels the invitee's booking(s) + declines their claim(s). */}
      <AlertDialog open={!!freeTarget} onOpenChange={(o) => { if (!o) setFreeTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('rebookManage.freeSeatTitle', 'Plek vrijgeven voor {{name}}?', { name: freeTarget?.player.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('rebookManage.freeSeatBody', 'De reservering van deze speler voor deze sessies wordt geannuleerd en de plek komt weer vrij voor vaste spelers of het publiek. De speler wordt hiervan niet automatisch op de hoogte gebracht.')}
              {freeTarget?.player.paid && (
                <span className="mt-2 block font-medium text-rose-600">
                  {t('rebookManage.freeSeatPaidWarning', 'Let op: deze speler heeft al betaald. De betaling wordt niet automatisch teruggestort — regel de terugbetaling zelf.')}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('common:cancel', 'Annuleren')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmFreeSeat} disabled={busy} className="bg-rose-600 hover:bg-rose-700">
              {busy ? t('common:loading', 'Bezig...') : t('rebookManage.freeSeatConfirm', 'Plek vrijgeven')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!reinstateTarget} onOpenChange={(o) => { if (!o) setReinstateTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('rebookManage.reinstateTitle', '{{name}} toch herboeken?', { name: reinstateTarget?.player.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('rebookManage.reinstateBody', 'Deze speler krijgt zijn plek voor alle sessies van deze reeks terug. Heeft de groep de baan al betaald, dan is de speler meteen gedekt (geen extra kosten); anders staat de plek open en moet er nog betaald worden. Een sessie die inmiddels vol zit, wordt overgeslagen.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('common:cancel', 'Annuleren')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmReinstate} disabled={busy} className="bg-emerald-600 hover:bg-emerald-700">
              {busy ? t('common:loading', 'Bezig...') : t('rebookManage.reinstateConfirm', 'Toch herboeken')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RebookRows({ g, isOpen, rebooked, paid, selected, statusLabel, onToggleSelect, onToggleExpand, selectedPlayers, onTogglePlayer, onFreeSeat, onReinstate, playerFilter, t }: {
  g: RebookManageGroup;
  isOpen: boolean;
  rebooked: number;
  paid: number;
  selected: boolean;
  statusLabel: (s: GroupStatus) => string;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
  selectedPlayers: Map<string, RebookReminderTarget>;
  onTogglePlayer: (key: string, target: RebookReminderTarget) => void;
  onFreeSeat: (player: RebookManagePlayer) => void;
  onReinstate: (player: RebookManagePlayer) => void;
  /** When set, only matching players render as sub-rows (the clicked-yes follow-up filter).
   *  Group-level counts stay computed over ALL players — the filter narrows the listing only. */
  playerFilter?: (p: RebookManagePlayer) => boolean;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const claimedCount = g.players.filter((p) => p.response === 'claimed').length;
  // Manual sharing (WhatsApp etc.) — clipboard only: tokens are sensitive, never logged or
  // sent to analytics. The CLAIM link is each invitee's accept-and-pay entry (works for
  // everyone, incl. emailless guests — RB05); the PAY link (/pay/:token, deliberately NOT
  // lang-prefixed) goes straight to the Mollie checkout of an already-minted UNPAID invoice.
  const copyClaimLink = async (token: string) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/nl/claim/${token}`);
      toast.success(t('rebookManage.linkCopied', 'Uitnodigingslink gekopieerd'));
    } catch {
      toast.error(t('rebookManage.linkCopyFailed', 'Kopiëren mislukt'));
    }
  };
  const copyPayLink = async (token: string) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/pay/${token}`);
      toast.success(t('rebookManage.payLinkCopied', 'Betaallink gekopieerd'));
    } catch {
      toast.error(t('rebookManage.linkCopyFailed', 'Kopiëren mislukt'));
    }
  };
  return (
    <>
      <TableRow className="cursor-pointer" onClick={onToggleExpand}>
        <TableCell onClick={(e) => e.stopPropagation()}>
          <Checkbox checked={selected} onCheckedChange={onToggleSelect} aria-label="select session" />
        </TableCell>
        <TableCell className="text-muted-foreground">
          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </TableCell>
        <TableCell className="font-medium capitalize whitespace-nowrap">{g.weekday} {g.time}</TableCell>
        <TableCell className="hidden md:table-cell text-muted-foreground">{g.trainerName || '—'}</TableCell>
        <TableCell className="hidden lg:table-cell text-muted-foreground">{g.locationName || '—'}</TableCell>
        <TableCell><Badge variant="outline" className={STATUS_STYLE[g.status]}>{statusLabel(g.status)}</Badge></TableCell>
        <TableCell className="text-right whitespace-nowrap">{rebooked}/{g.capacity || g.players.length}</TableCell>
        <TableCell className="text-right whitespace-nowrap">
          {claimedCount === 0 ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <span className={paid === claimedCount ? 'text-emerald-600' : 'text-rose-600'}>{paid}/{claimedCount}</span>
          )}
        </TableCell>
      </TableRow>
      {isOpen && ((playerFilter ? g.players.filter(playerFilter) : g.players).length === 0 ? (
        <TableRow className="bg-muted/20 hover:bg-muted/20">
          <TableCell />
          <TableCell />
          <TableCell colSpan={6} className="text-xs text-muted-foreground">
            {t('rebookManage.noPlayers', 'Geen spelers in deze sessie.')}
          </TableCell>
        </TableRow>
      ) : (
        // One aligned SUB-ROW per player (same compact height as the rest of the table); cells
        // mirror the header's responsive columns so counts line up at every breakpoint.
        (playerFilter ? g.players.filter(playerFilter) : g.players).map((p) => {
          const sel = selectedPlayers.has(p.key);
          // Outcome (not raw status) drives the icon so a "clicked No" that is still
          // technically a pending claim reads as a decline, and expired ≠ declined.
          const outcome = rebookPlayerOutcome(p);
          const Icon = outcome === 'rebooked' ? CheckCircle2 : outcome === 'declined' ? XCircle : Clock;
          const tone = outcome === 'rebooked' ? 'text-emerald-600' : outcome === 'declined' ? 'text-rose-600' : 'text-amber-600';
          const emailless = !p.hasEmail;
          return (
            <TableRow key={p.key} className="bg-muted/20 hover:bg-muted/40" data-state={sel ? 'selected' : undefined}>
              {/* c1: select for reminder (was chip-click — a checkbox is clearer + consistent). */}
              <TableCell>
                <Checkbox
                  checked={sel}
                  onCheckedChange={() => onTogglePlayer(p.key, { player_id: p.playerId, guest_player_id: p.guestPlayerId })}
                  aria-label={t('rebookManage.selectForReminder', 'Selecteer voor herinnering')}
                />
              </TableCell>
              <TableCell />
              {/* c3 (Sessie): indented player name + outcome icon. */}
              <TableCell className="max-w-[240px]">
                <span className="flex min-w-0 items-center gap-1.5 pl-4">
                  <Icon className={`h-3.5 w-3.5 shrink-0 ${tone}`} />
                  <span className="truncate" title={p.name}>{p.name}</span>
                </span>
              </TableCell>
              {/* c4 (Trainer col, md+): initial-invite delivery. */}
              <TableCell className="hidden md:table-cell text-xs">
                {emailless ? (
                  <span className="inline-flex items-center gap-1 text-rose-600">
                    <MailX className="h-3 w-3" /> {t('rebookManage.noEmailShort', 'geen e-mail')}
                  </span>
                ) : p.invited ? (
                  <span className="inline-flex items-center gap-1 text-muted-foreground" title={t('rebookManage.inviteSent', 'Uitnodiging verstuurd')}>
                    <MailCheck className="h-3 w-3" /> {t('rebookManage.inviteSentShort', 'verstuurd')}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-amber-700" title={t('rebookManage.inviteNotSent', 'Uitnodiging nog niet verstuurd')}>
                    <Mail className="h-3 w-3" /> {t('rebookManage.inviteNotSentShort', 'niet verstuurd')}
                  </span>
                )}
              </TableCell>
              {/* c5 (Locatie col, lg+): last reminder. */}
              <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">
                {p.lastRemindedAt
                  ? <span title={t('rebookManage.lastReminded', 'Laatst herinnerd op {{date}}', { date: fmtReminded(p.lastRemindedAt) })}>
                      {t('rebookManage.remindedShort', 'herinnerd')} {fmtReminded(p.lastRemindedAt)}
                    </span>
                  : '—'}
              </TableCell>
              {/* c6 (Status): this player's own state, incl. the ambiguous awaiting variants. */}
              <TableCell className="text-xs">
                {p.response === 'claimed' ? (
                  <span className="text-emerald-700">{t('rebookManage.status.rebooked', 'Geherboekt')}</span>
                ) : p.responseIntent === 'decline' ? (
                  <span className="text-rose-600">{t('rebookManage.saidNoShort', 'zei nee')}</span>
                ) : p.response === 'expired' ? (
                  clickedYesUnpaid(p) ? (
                    // Clicked "Yes" but the window lapsed before payment — the round's hottest
                    // follow-up lead. Extending the round deadline revives the claim (second chance).
                    <span
                      className="text-amber-700"
                      title={t('rebookManage.clickedYesExpiredHint', 'Klikte Ja maar rondde de betaling niet af voor de deadline. Verleng de deadline om een tweede kans te geven — de claim- en betaallinks werken dan weer.')}
                    >
                      {t('rebookManage.clickedYesShort', 'klikte Ja')} — {t('rebookManage.expiredShort', 'verlopen')}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{t('rebookManage.expiredShort', 'verlopen')}</span>
                  )
                ) : clickedYesUnpaid(p) ? (
                  <span className="text-amber-700">{t('rebookManage.clickedYesShort', 'klikte Ja')} — {t('rebookManage.unpaidShort', 'open')}</span>
                ) : (
                  <span className="text-muted-foreground">{t('rebookManage.status.awaiting', 'Wacht op reactie')}</span>
                )}
              </TableCell>
              {/* c7 (Geherboekt): did THIS player rebook. */}
              <TableCell className="text-right">
                {p.response === 'claimed'
                  ? <CheckCircle2 className="ml-auto h-4 w-4 text-emerald-600" aria-label={t('rebookManage.status.rebooked', 'Geherboekt')} />
                  : <span className="text-muted-foreground">—</span>}
              </TableCell>
              {/* c8 (Betaald): paid state + the per-player actions (copy links, free seat). */}
              <TableCell className="text-right">
                <span className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap">
                  {p.response === 'claimed' && (
                    <span className={`text-xs ${p.paid ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {p.paid ? t('rebookManage.paidShort', 'betaald') : t('rebookManage.unpaidShort', 'open')}
                    </span>
                  )}
                  {/* Copy claim link — every unpaid invitee (WhatsApp-able accept-and-pay entry). */}
                  {!p.paid && p.claimToken && (
                    <button
                      type="button"
                      onClick={() => copyClaimLink(p.claimToken!)}
                      className="inline-flex items-center rounded-full border border-slate-200 bg-background p-1 text-muted-foreground hover:text-foreground"
                      title={t('rebookManage.copyClaimLink', 'Kopieer uitnodigingslink om zelf te delen')}
                      aria-label={t('rebookManage.copyClaimLink', 'Kopieer uitnodigingslink om zelf te delen')}
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                  )}
                  {/* Copy PAY link — direct to the Mollie checkout of their unpaid invoice. */}
                  {!p.paid && p.payToken && (
                    <button
                      type="button"
                      onClick={() => copyPayLink(p.payToken!)}
                      className="inline-flex items-center rounded-full border border-slate-200 bg-background p-1 text-muted-foreground hover:text-emerald-700"
                      title={t('rebookManage.copyPayLink', 'Kopieer betaallink (direct naar de checkout)')}
                      aria-label={t('rebookManage.copyPayLink', 'Kopieer betaallink (direct naar de checkout)')}
                    >
                      <CreditCard className="h-3 w-3" />
                    </button>
                  )}
                  {/* Free this invitee's seat (they're not rebooking) — claimed or still-holding. */}
                  {(p.response === 'claimed' || p.response === 'pending') && (
                    <button
                      type="button"
                      onClick={() => onFreeSeat(p)}
                      className="inline-flex items-center rounded-full border border-slate-200 bg-background p-1 text-muted-foreground hover:text-rose-600"
                      title={t('rebookManage.freeSeatAction', 'Plek vrijgeven (niet herboekt)')}
                      aria-label={t('rebookManage.freeSeatAction', 'Plek vrijgeven (niet herboekt)')}
                    >
                      <UserMinus className="h-3 w-3" />
                    </button>
                  )}
                  {/* Reinstate: they declined (accidentally) — put them back on the list. */}
                  {p.response === 'declined' && (
                    <button
                      type="button"
                      onClick={() => onReinstate(p)}
                      className="inline-flex items-center rounded-full border border-slate-200 bg-background p-1 text-muted-foreground hover:text-emerald-700"
                      title={t('rebookManage.reinstateAction', 'Toch herboeken (plek weer toewijzen)')}
                      aria-label={t('rebookManage.reinstateAction', 'Toch herboeken')}
                    >
                      <UserPlus className="h-3 w-3" />
                    </button>
                  )}
                </span>
              </TableCell>
            </TableRow>
          );
        })
      ))}
    </>
  );
}
