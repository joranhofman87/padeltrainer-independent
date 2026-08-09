import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2, Check, X, Users, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/format';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import {
  applyRebookGroup, manageRebookGroup, createRebookGroupGuest,
  type RebookGroup, type RebookGroupApplyResult, type RebookPaymentMode,
} from '@/lib/priorityClaims';
import { AddGroupMemberFields, type NewGroupMember } from './AddGroupMemberFields';

interface Props {
  token: string;
  group: RebookGroup;
  paymentMode: RebookPaymentMode;
  /**
   * 'apply'  = deferred cycles — book the group now; each player is billed their own split
   *            share when the cycle starts (no payment up front).
   * 'manage' = upfront cycles, AFTER the captain has paid the fixed group price — assign/change
   *            the roster; the booked members are COVERED by that payment (no extra charge).
   */
  mode?: 'apply' | 'manage';
  /** The captain's paid group invoice — only in 'manage' mode; links covered bookings onto it. */
  invoiceId?: string;
  onBack: () => void;
  /** Called after a successful group re-book with the RPC result. */
  onDone: (result: RebookGroupApplyResult) => void;
}

/**
 * Captain flow: one group member re-books the WHOLE group. Lists the current members
 * (keep/remove), lets the captain add new people (minimal details), and applies the
 * roster diff + booking in one atomic call. The captain row is always kept.
 */
export function RebookGroupEditor({ token, group, paymentMode, mode = 'apply', invoiceId, onBack, onDone }: Props) {
  const { t } = useTranslation('cycles');
  // Default: keep everyone who hasn't already declined; the captain is forced-kept server-side.
  const [keep, setKeep] = useState<Set<string>>(
    () => new Set(group.members.filter((m) => m.status !== 'declined').map((m) => m.key)),
  );
  /**
   * Each new member carries the id of the attempt that will create them, stamped when the captain
   * ADDS them rather than when the group is submitted. A submit that fails halfway — a capacity
   * refusal, a dropped connection — is retried with the same ids, so the members who already landed
   * replay instead of being minted a second time (U2: the address no longer recognises a repeat).
   */
  const [newMembers, setNewMembers] = useState<Array<NewGroupMember & { creationRequestId: string }>>([]);
  const [submitting, setSubmitting] = useState(false);

  const sessions = group.sessions || 1;
  const pricePer = Number((group.slot?.price_per_session as number | null) ?? 0);
  // The group/court total is the FULL session price × weeks — independent of headcount
  // (split shares always sum back to the full price).
  const groupTotal = pricePer * sessions;

  const keptCount = useMemo(
    () => group.members.filter((m) => keep.has(m.key) || m.is_self).length + newMembers.length,
    [group.members, keep, newMembers],
  );

  const toggle = (key: string, isSelf: boolean) => {
    if (isSelf) return; // captain is always in
    setKeep((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      // Mint each new member server-side (token-gated), collecting their guest ids.
      const newGuestIds: string[] = [];
      for (const m of newMembers) {
        const id = await createRebookGroupGuest(token, m);
        newGuestIds.push(id);
      }
      const keepKeys = group.members.filter((m) => keep.has(m.key) && !m.is_self).map((m) => m.key);
      const res = mode === 'manage'
        ? await manageRebookGroup(token, { keepKeys, newGuestIds, invoiceId })
        : await applyRebookGroup(token, { keepKeys, newGuestIds });
      if (!res.ok) {
        if (res.reason === 'window_expired') {
          toast.error(t('rebooking.errorExpired', 'The reservation period has expired.'));
        } else if (res.reason === 'already_responded') {
          toast.info(t('rebookGroup.alreadyDone', 'Deze groep is al opnieuw ingeschreven.'));
        } else if (res.reason === 'not_paid') {
          toast.error(t('rebookGroup.notPaid', 'Rond eerst de betaling af om je groep samen te stellen.'));
        } else if (res.reason === 'upfront_cycle') {
          // Server-side upfront guard (migration 20260804100000): the deferred apply path refuses
          // pay-first rounds — only reachable when the client's mode resolution went stale.
          toast.error(t('rebookGroup.upfrontCycle', 'Deze ronde werkt met direct betalen. Ververs de pagina en gebruik de betaalknop.'));
        } else {
          toast.error(t('rebooking.errorGeneric', 'Something went wrong. Please try again.'));
        }
        onDone(res);
        return;
      }
      onDone(res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/rate_limit/i.test(msg)) {
        toast.error(t('rebookGroup.rateLimited', 'Je hebt te veel spelers achter elkaar toegevoegd. Wacht een paar minuten en probeer het opnieuw.'));
      } else {
        toast.error(getFriendlyErrorMessage(e, t('rebooking.errorGeneric', 'Something went wrong. Please try again.')));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={submitting} className="-ml-2">
          <ArrowLeft className="h-4 w-4 mr-1" /> {t('common:back', 'Terug')}
        </Button>
      </div>

      <div className="flex items-start gap-2 text-sm">
        <Users className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
        <p className="text-muted-foreground">
          {mode === 'manage'
            ? t('rebookGroup.introManage', 'Je betaling is rond. Stel hieronder je groep samen — deze spelers vallen onder jouw betaling.')
            : t('rebookGroup.intro', 'Schrijf je hele groep opnieuw in voor de volgende cyclus. Houd dezelfde spelers of pas de groep aan.')}
        </p>
      </div>

      {/* Current members */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">{t('rebookGroup.currentMembers', 'Huidige spelers')}</p>
        {group.members.map((m) => {
          const kept = m.is_self || keep.has(m.key);
          return (
            <div key={m.key} className={`flex items-center justify-between rounded-md border px-3 py-2 ${kept ? '' : 'opacity-50'}`}>
              <span className="text-sm">
                {m.first_name}
                {m.is_self && <span className="text-xs text-muted-foreground"> · {t('rebookGroup.you', 'jij')}</span>}
                {m.status === 'declined' && <span className="text-xs text-muted-foreground"> · {t('rebookGroup.previouslyReleased', 'eerder afgemeld')}</span>}
                {!m.has_email && <span className="text-xs text-muted-foreground"> · {t('rebookGroup.noEmail', 'geen e-mail')}</span>}
              </span>
              <Button
                type="button" size="sm" variant={kept ? 'ghost' : 'outline'}
                onClick={() => toggle(m.key, m.is_self)} disabled={submitting || m.is_self}
                className="h-7 px-2 text-xs"
              >
                {kept ? <><Check className="h-3.5 w-3.5 mr-1" />{t('rebookGroup.keep', 'Behouden')}</>
                      : <><X className="h-3.5 w-3.5 mr-1" />{t('rebookGroup.removed', 'Verwijderd')}</>}
              </Button>
            </div>
          );
        })}
      </div>

      {/* New members */}
      {newMembers.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">{t('rebookGroup.newMembers', 'Nieuwe spelers')}</p>
          {newMembers.map((m, i) => (
            <div key={i} className="flex items-center justify-between rounded-md border px-3 py-2">
              <span className="text-sm">{[m.firstName, m.lastName].filter(Boolean).join(' ')}{m.email ? ` · ${m.email}` : ''}</span>
              <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs"
                title={t('rebookGroup.removed', 'Verwijderd')} aria-label={t('rebookGroup.removed', 'Verwijderd')}
                onClick={() => setNewMembers((prev) => prev.filter((_, j) => j !== i))} disabled={submitting}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <AddGroupMemberFields disabled={submitting} onAdd={(m) => setNewMembers((prev) => [...prev, { ...m, creationRequestId: crypto.randomUUID() }])} />

      {/* Price preview */}
      {pricePer > 0 && (
        <div className="rounded-md bg-muted/50 p-3 text-sm">
          <p className="font-medium">{t('rebookGroup.summary', '{{count}} spelers · {{total}} voor de hele termijn', { count: keptCount, total: formatCurrency(groupTotal) })}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {mode === 'manage'
              ? t('rebookGroup.coveredNote', 'Al betaald — deze spelers vallen onder jouw betaling.')
              : paymentMode === 'upfront'
                ? t('rebookGroup.payNote', 'Jij rekent de hele groep in één keer af.')
                : t('rebookGroup.payLaterNote', 'Je betaalt pas wanneer de cyclus start; de prijs wordt over de groep verdeeld.')}
          </p>
        </div>
      )}

      <Button onClick={handleSubmit} disabled={submitting || keptCount === 0} className="w-full">
        {submitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Users className="h-4 w-4 mr-2" />}
        {mode === 'manage'
          ? t('rebookGroup.confirmManage', 'Groep opslaan')
          : t('rebookGroup.confirm', 'Groep opnieuw inschrijven')}
      </Button>
    </div>
  );
}
