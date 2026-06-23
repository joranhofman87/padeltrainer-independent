import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ArrowLeft, Globe, EyeOff, Mail, CheckCircle2, Clock, XCircle, Users } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  getCycleRebookStatus, bulkReleaseToPublic, bulkHoldSlots, sendRebookReminder,
  type GroupStatus, type RebookManageGroup, type RebookReminderTarget,
} from '@/lib/rebookManage';

const STATUS_STYLE: Record<GroupStatus, string> = {
  rebooked: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  awaiting: 'bg-amber-100 text-amber-800 border-amber-200',
  declined: 'bg-rose-100 text-rose-800 border-rose-200',
  members: 'bg-sky-100 text-sky-800 border-sky-200',
  public: 'bg-slate-100 text-slate-700 border-slate-200',
};
const STATUS_ORDER: GroupStatus[] = ['rebooked', 'awaiting', 'declined', 'members', 'public'];

export default function AcademyRebookManage() {
  const { cycleId } = useParams<{ cycleId: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation('cycles');

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['rebook-manage', cycleId],
    queryFn: () => getCycleRebookStatus(cycleId!),
    enabled: !!cycleId,
  });

  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [selectedPlayers, setSelectedPlayers] = useState<Map<string, RebookReminderTarget>>(new Map());
  const [busy, setBusy] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');

  const statusLabel = (s: GroupStatus) => t(`rebookManage.status.${s}`, {
    rebooked: 'Geherboekt', awaiting: 'Wacht op reactie', declined: 'Niet geherboekt',
    members: 'Open voor vaste spelers', public: 'Open voor iedereen',
  }[s]);

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

  const selectedSlotIds = useMemo(() => {
    if (!data) return [] as string[];
    return data.groups.filter((g) => selectedGroups.has(g.groupId)).flatMap((g) => g.slotIds);
  }, [data, selectedGroups]);

  const clearSelection = () => { setSelectedGroups(new Set()); setSelectedPlayers(new Map()); };

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
    } finally { setBusy(false); }
  };

  if (isLoading) {
    return <div className="p-4 space-y-3"><Skeleton className="h-8 w-64" /><Skeleton className="h-40 w-full" /></div>;
  }

  const groups = data?.groups ?? [];

  return (
    <div className="p-4 space-y-4 max-w-5xl mx-auto">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/app/academy/cycles/${cycleId}`)}>
          <ArrowLeft className="h-4 w-4 mr-1" /> {t('common:back', 'Terug')}
        </Button>
        <h1 className="text-lg font-semibold truncate">
          {t('rebookManage.title', 'Herboeking beheren')}{data?.cycleName ? ` — ${data.cycleName}` : ''}
        </h1>
      </div>

      {/* Summary */}
      <div className="flex flex-wrap gap-2">
        {STATUS_ORDER.map((s) => (
          <Badge key={s} variant="outline" className={STATUS_STYLE[s]}>
            {statusLabel(s)}: {data?.counts[s] ?? 0}
          </Badge>
        ))}
        <Badge variant="outline" className="bg-emerald-100 text-emerald-800 border-emerald-200">
          {t('rebookManage.paid', 'Betaald')}: {data?.paidCount ?? 0}
        </Badge>
        <Badge variant="outline" className="bg-rose-100 text-rose-800 border-rose-200">
          {t('rebookManage.unpaid', 'Open')}: {data?.unpaidCount ?? 0}
        </Badge>
      </div>

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
          <Button size="sm" disabled={busy || selectedPlayers.size === 0} onClick={() => setComposeOpen(true)}>
            <Mail className="h-4 w-4 mr-1" /> {t('rebookManage.emailReminder', 'Herinnering mailen')}
          </Button>
          <Button size="sm" variant="ghost" onClick={clearSelection}>{t('common:clear', 'Wissen')}</Button>
        </div>
      )}

      {groups.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t('rebookManage.empty', 'Geen herboekingsgegevens voor deze cyclus.')}
        </CardContent></Card>
      ) : (
        <div className="space-y-2">
          {groups.map((g) => (
            <GroupRow key={g.groupId} g={g} statusLabel={statusLabel}
              selected={selectedGroups.has(g.groupId)} onToggle={() => toggleGroup(g.groupId)}
              selectedPlayers={selectedPlayers} onTogglePlayer={togglePlayer} t={t} />
          ))}
        </div>
      )}
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
            <div>
              <Label>{t('rebookManage.composeMessage', 'Bericht')}</Label>
              <Textarea value={message} maxLength={1000} rows={5} onChange={(e) => setMessage(e.target.value)}
                placeholder={t('rebookManage.composeMessagePlaceholder', 'Korte herinnering aan je spelers…')} />
              <p className="text-xs text-muted-foreground mt-1">{t('rebookManage.composeHint', 'Platte tekst. We voegen je academienaam en een knop naar hun uitnodiging toe.')}</p>
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

function GroupRow({ g, statusLabel, selected, onToggle, selectedPlayers, onTogglePlayer, t }: {
  g: RebookManageGroup;
  statusLabel: (s: GroupStatus) => string;
  selected: boolean;
  onToggle: () => void;
  selectedPlayers: Map<string, RebookReminderTarget>;
  onTogglePlayer: (key: string, target: RebookReminderTarget) => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const rebooked = g.players.filter((p) => p.response === 'claimed').length;
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-2">
          <Checkbox checked={selected} onCheckedChange={onToggle} aria-label="select session" />
          <span className="font-medium capitalize">{g.weekday} {g.time}</span>
          <Badge variant="outline" className={STATUS_STYLE[g.status]}>{statusLabel(g.status)}</Badge>
          <span className="ml-auto text-xs text-muted-foreground inline-flex items-center gap-1">
            <Users className="h-3.5 w-3.5" /> {t('rebookManage.seatLine', '{{r}}/{{c}} geherboekt', { r: rebooked, c: g.capacity || g.players.length })}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5 pl-6">
          {g.players.map((p) => {
            const sel = selectedPlayers.has(p.key);
            const Icon = p.response === 'claimed' ? CheckCircle2 : p.response === 'declined' ? XCircle : Clock;
            const tone = p.response === 'claimed' ? 'text-emerald-600' : p.response === 'declined' ? 'text-rose-600' : 'text-amber-600';
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => onTogglePlayer(p.key, { player_id: p.playerId, guest_player_id: p.guestPlayerId })}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${sel ? 'border-primary bg-primary/10' : 'border-slate-200'}`}
              >
                <Icon className={`h-3.5 w-3.5 ${tone}`} />
                <span>{p.name}</span>
                {p.response === 'claimed' && (
                  <span className={p.paid ? 'text-emerald-600' : 'text-rose-600'}>
                    · {p.paid ? t('rebookManage.paidShort', 'betaald') : t('rebookManage.unpaidShort', 'open')}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
