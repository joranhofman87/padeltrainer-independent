import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ArrowLeft, Globe, EyeOff, Mail, Send, CheckCircle2, Clock, XCircle, ChevronRight, ChevronDown, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmailMessageField } from '@/components/email/EmailMessageField';
import { Skeleton } from '@/components/ui/skeleton';
import { SelectFilter } from '@/components/ui/select-filter';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  getCycleRebookStatus, bulkReleaseToPublic, bulkHoldSlots, sendRebookReminder,
  rebookPlayerOutcome, clickedYesUnpaid,
  type GroupStatus, type RebookManageGroup, type RebookReminderTarget,
} from '@/lib/rebookManage';
import { drainRebookInvites } from '@/lib/rebookInviteSend';

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
  const { t } = useTranslation('cycles');

  const { data, isLoading, refetch, isFetching } = useQuery({
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
  }, [groups, search, statusFilter, paymentFilter, trainerFilter, locationFilter]);

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
      if (!res.ok && res.sent === 0) {
        toast.error(t('rebookManage.reminderFailed', 'Kon de herinnering niet versturen. Probeer het later opnieuw.'));
      } else if (res.skipped > 0 || res.failed > 0) {
        toast.success(t('rebookManage.reminderPartial', '{{sent}} verstuurd, {{skip}} overgeslagen', { sent: res.sent, skip: res.skipped + res.failed }));
      } else {
        toast.success(t('rebookManage.reminderDone', '{{sent}} herinneringen verstuurd', { sent: res.sent }));
      }
      setComposeOpen(false); setSubject(''); setMessage(''); clearSelection();
      refetch(); // refresh "last reminded" chips + already-reminded counts so we don't double-nudge
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
      const res = await drainRebookInvites(cycleId, {
        onProgress: ({ totalSent }) => setSendProgress({ sent: totalSent, total }),
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

  if (isLoading) {
    return <div className="p-4 space-y-3"><Skeleton className="h-8 w-64" /><Skeleton className="h-40 w-full" /></div>;
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
      </div>

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
              <span className="font-semibold">{data.summary.clickedYesUnpaid}</span>{' '}
              {t('rebookManage.summary.clickedYesUnpaid', 'klikte Ja, niet afgerond')}
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
          {t('rebookManage.paid', 'Betaald')}: {data?.paidCount ?? 0}
        </Badge>
        <Badge variant="outline" className="bg-rose-100 text-rose-800 border-rose-200">
          {t('rebookManage.unpaid', 'Open')}: {data?.unpaidCount ?? 0}
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
          <Button size="sm" variant="outline" disabled={busy || selectedSlotIds.length === 0}
            onClick={() => runBulk(bulkReleaseToPublic, 'rebookManage.openedPublic', '{{count}} sessies opengezet')}>
            <Globe className="h-4 w-4 mr-1" /> {t('rebookManage.openToPublic', 'Open voor iedereen')}
          </Button>
          <Button size="sm" variant="outline" disabled={busy || selectedSlotIds.length === 0}
            onClick={() => runBulk(bulkHoldSlots, 'rebookManage.madePrivate', '{{count}} sessies verborgen')}>
            <EyeOff className="h-4 w-4 mr-1" /> {t('rebookManage.makePrivate', 'Verbergen')}
          </Button>
          <Button size="sm" disabled={busy || selectedPlayers.size === 0}
            onClick={() => { if (!message.trim() && data?.invitationMessage) setMessage(data.invitationMessage); setComposeOpen(true); }}>
            <Mail className="h-4 w-4 mr-1" /> {t('rebookManage.emailReminder', 'Herinnering mailen')}
          </Button>
          <Button size="sm" variant="ghost" onClick={clearSelection}>{t('common:clear', 'Wissen')}</Button>
        </div>
      )}

      {/* Table */}
      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
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
              const isOpen = expanded.has(g.groupId);
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
                  t={t}
                />
              );
            })}
          </TableBody>
        </Table>
      </div>
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
    </div>
  );
}

function RebookRows({ g, isOpen, rebooked, paid, selected, statusLabel, onToggleSelect, onToggleExpand, selectedPlayers, onTogglePlayer, t }: {
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
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const claimedCount = g.players.filter((p) => p.response === 'claimed').length;
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
      {isOpen && (
        <TableRow>
          <TableCell />
          <TableCell colSpan={7} className="bg-muted/30">
            {g.players.length === 0 ? (
              <span className="text-xs text-muted-foreground">{t('rebookManage.noPlayers', 'Geen spelers in deze sessie.')}</span>
            ) : (
              <div className="flex flex-wrap gap-1.5 py-1">
                {g.players.map((p) => {
                  const sel = selectedPlayers.has(p.key);
                  // Outcome (not raw status) drives the icon so a "clicked No" that is still
                  // technically a pending claim reads as a decline, and expired ≠ declined.
                  const outcome = rebookPlayerOutcome(p);
                  const Icon = outcome === 'rebooked' ? CheckCircle2 : outcome === 'declined' ? XCircle : Clock;
                  const tone = outcome === 'rebooked' ? 'text-emerald-600' : outcome === 'declined' ? 'text-rose-600' : 'text-amber-600';
                  return (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => onTogglePlayer(p.key, { player_id: p.playerId, guest_player_id: p.guestPlayerId })}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${sel ? 'border-primary bg-primary/10' : 'border-slate-200 bg-background'}`}
                      title={t('rebookManage.selectForReminder', 'Selecteer voor herinnering')}
                    >
                      <Icon className={`h-3.5 w-3.5 ${tone}`} />
                      <span>{p.name}</span>
                      {p.response === 'claimed' && (
                        <span className={p.paid ? 'text-emerald-600' : 'text-rose-600'}>
                          · {p.paid ? t('rebookManage.paidShort', 'betaald') : t('rebookManage.unpaidShort', 'open')}
                        </span>
                      )}
                      {/* Distinguish the ambiguous "awaiting" states the owner asked about. */}
                      {clickedYesUnpaid(p) && (
                        <span className="text-amber-700">· {t('rebookManage.clickedYesShort', 'klikte Ja')}</span>
                      )}
                      {p.response !== 'claimed' && p.responseIntent === 'decline' && (
                        <span className="text-rose-600">· {t('rebookManage.saidNoShort', 'zei nee')}</span>
                      )}
                      {p.response === 'expired' && p.responseIntent !== 'decline' && (
                        <span className="text-muted-foreground">· {t('rebookManage.expiredShort', 'verlopen')}</span>
                      )}
                      {p.lastRemindedAt && (
                        <span
                          className="text-muted-foreground"
                          title={t('rebookManage.lastReminded', 'Laatst herinnerd op {{date}}', { date: fmtReminded(p.lastRemindedAt) })}
                        >
                          · {t('rebookManage.remindedShort', 'herinnerd')} {fmtReminded(p.lastRemindedAt)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
