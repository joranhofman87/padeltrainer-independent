import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { Clock, X, Globe, Loader2, Mail, Send } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { formatDate } from '@/lib/format';
import {
  getPriorityClaimsForSlot,
  declineClaimAsManager,
  endPriorityWindowNow,
  extendPriorityWindow,
  type ClaimStatus,
} from '@/lib/priorityClaims';

interface Props {
  slotId: string;
  onChange?: () => void;
}

interface ClaimRow {
  id: string;
  status: ClaimStatus;
  claim_token: string;
  responded_at: string | null;
  profiles: { id: string; full_name: string | null; email: string | null } | null;
  guest_players: { id: string; full_name: string | null; email: string | null } | null;
}

const statusVariant: Record<ClaimStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  pending: 'secondary',
  claimed: 'default',
  declined: 'outline',
  expired: 'outline',
  released: 'outline',
};

// Humanized labels for the raw DB claim status — never render the enum value.
const statusLabel: Record<ClaimStatus, { key: string; defaultValue: string }> = {
  pending: { key: 'priorityClaims.status.pending', defaultValue: 'Pending' },
  claimed: { key: 'priorityClaims.status.claimed', defaultValue: 'Claimed' },
  declined: { key: 'priorityClaims.status.declined', defaultValue: 'Declined' },
  expired: { key: 'priorityClaims.status.expired', defaultValue: 'Expired' },
  released: { key: 'priorityClaims.status.released', defaultValue: 'Released' },
};

export default function PriorityClaimsSection({ slotId, onChange }: Props) {
  const { t } = useTranslation('cycles');
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [priorityWindowEndsAt, setPriorityWindowEndsAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [invitingClaimId, setInvitingClaimId] = useState<string | null>(null);
  const [sendingAll, setSendingAll] = useState(false);
  const [extending, setExtending] = useState(false);
  // An unread deadline is not an absent deadline. See `reload`.
  const [deadlineUnknown, setDeadlineUnknown] = useState(false);
  // The cycle this session belongs to is not open — the enqueue would refuse (D3).
  const [cycleClosed, setCycleClosed] = useState(false);
  // Both paths email the same claimants; block one while the other runs.
  const inviteBusy = invitingClaimId !== null || sendingAll;

  const reload = async () => {
    setLoading(true);
    try {
      const [claimsData, slot] = await Promise.all([
        getPriorityClaimsForSlot(slotId),
        // The CYCLE STATUS travels with the deadline (D3). The enqueue refuses a claim whose cycle
        // is not open, so offering the action at all would promise something the server must
        // refuse — and before the refusal existed it queued a row that could only ever be held.
        supabase.from('availability_slots')
          .select('priority_window_ends_at, cyclus_id, cycles:cyclus_id(status)')
          .eq('id', slotId).maybeSingle(),
      ]);
      setClaims(claimsData as unknown as ClaimRow[]);
      // FAIL CLOSED ON THE DEADLINE. `slot.error` used to be dropped, so a failed read became a
      // NULL deadline — and a null deadline reads as "the window has not ended", which re-enabled
      // the Invite buttons past the real cutoff (review round 4). An unknown deadline is treated as
      // a closed window: the enqueue would succeed and the verdict could only hold it.
      if (slot.error) throw slot.error;
      setPriorityWindowEndsAt(slot.data?.priority_window_ends_at ?? null);
      setDeadlineUnknown(false);
      // A session naming a cycle that does not exist is NOT an open cycle — the same rule the
      // enqueue applies, keyed on the id rather than on the status being non-null.
      const cyc = slot.data as { cyclus_id: string | null; cycles: { status: string | null } | null } | null;
      const embedded = Array.isArray(cyc?.cycles) ? cyc?.cycles[0] : cyc?.cycles;
      setCycleClosed(!!cyc?.cyclus_id && (embedded?.status ?? null) !== 'open');
    } catch (e) {
      setDeadlineUnknown(true);
      setCycleClosed(true);
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, [slotId]);

  // THE CUTOFF ARRIVES ON ITS OWN, without a render to notice it.
  //
  // `windowEnded` was computed only while rendering, so a page opened a minute before the deadline
  // and left idle kept its Invite buttons live indefinitely — the manager clicks after the window
  // has closed, the row enqueues, and the verdict can only ever move it to `configuration_hold`
  // (review round 2). A single timer set for the deadline re-renders exactly once, when it matters.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!priorityWindowEndsAt) return;
    const msLeft = new Date(priorityWindowEndsAt).getTime() - Date.now();
    if (msLeft <= 0) return;
    // setTimeout clamps above ~24.8 days; re-arm rather than fire immediately.
    const id = setTimeout(() => setNow(Date.now()), Math.min(msLeft + 1000, 2_000_000_000));
    return () => clearTimeout(id);
  }, [priorityWindowEndsAt, now]);

  if (loading) return null;
  if (claims.length === 0 && !priorityWindowEndsAt) return null;

  // ONE GATE for both send actions: the window has ended, the deadline could not be read, or the
  // cycle is not open. Each is a state in which the server will refuse, so offering the action
  // would be a promise the system cannot keep.
  const windowEnded = deadlineUnknown || cycleClosed
    || (priorityWindowEndsAt && new Date(priorityWindowEndsAt).getTime() < now);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-base">{t('priorityClaims.title', 'Priority rebooking')}</CardTitle>
          {priorityWindowEndsAt && (
            <Badge variant={windowEnded ? 'outline' : 'secondary'} className="gap-1">
              <Clock className="h-3 w-3" />
              {windowEnded
                ? t('priorityClaims.ended', 'Window ended')
                : t('priorityClaims.endsAt', { date: formatDate(priorityWindowEndsAt, 'd MMM yyyy HH:mm'), defaultValue: 'Ends {{date}}' })}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {claims.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('priorityClaims.empty', 'No priority players assigned to this slot.')}</p>
        ) : (
          <div className="space-y-2">
            {claims.map((c) => {
              const name = c.profiles?.full_name || c.guest_players?.full_name || c.profiles?.email || c.guest_players?.email || '—';
              return (
                <div key={c.id} className="flex items-center justify-between gap-2 border rounded p-2">
                  <div>
                    <div className="text-sm font-medium">{name}</div>
                    <div className="text-xs text-muted-foreground">{c.profiles?.email || c.guest_players?.email}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={statusVariant[c.status]}>{t(statusLabel[c.status].key, statusLabel[c.status].defaultValue)}</Badge>
                    {c.status === 'pending' && (
                      <>
                        {/* INVITE IS GATED BY THE WINDOW, exactly as Invite All is. The server
                            deliberately allows an invitation to be BORN after the cutoff and holds
                            it at verdict time, so an ungated button told the manager "Invitation
                            queued" for a row that can only ever become `configuration_hold`.
                            RELEASE stays available: closing the window does not stop a manager
                            from letting a place go. */}
                        {!windowEnded && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={inviteBusy}
                          onClick={async () => {
                            setInvitingClaimId(c.id);
                            try {
                              // resend: the trainer deliberately re-invites this
                              // one player; the function still refuses claims
                              // that are no longer pending.
                              const { data, error } = await supabase.functions.invoke('send-priority-claim-invitation', { body: { claimIds: [c.id], resend: true } });
                              if (error) throw error;
                              const result = data as {
                                queued?: number; already?: number; suppressed?: number;
                                held?: number; unstamped?: number; failed?: number;
                              } | null;
                              // DISJOINT buckets, summed once. `unstamped` means the invitation IS
                              // queued and only the record of it failed — so it appears here AND in
                              // the success line, which is the truth rather than a contradiction.
                              const needsAttention = (result?.suppressed ?? 0) + (result?.held ?? 0)
                                + (result?.unstamped ?? 0) + (result?.failed ?? 0);
                              const queued = (result?.queued ?? 0) + (result?.unstamped ?? 0);
                              if (queued > 0) {
                                // QUEUED, not sent. Since the cutover this button's success means a
                                // durable enqueue; delivery is the D7 worker's, and it is inactive.
                                toast.success(t('priorityClaims.invitationQueued', 'Invitation queued for delivery'));
                                // ...and `sent` and `unresolved` are NOT disjoint: an enqueue whose
                                // `invited_at` stamp failed returns BOTH, and the claim stays
                                // un-stamped. Reporting only the success hid that (review round 4) —
                                // but the round-4 wording then said the invitation "could not be
                                // queued" about one that HAD been (round 5). It was queued; what
                                // failed is the record of it, and that is what the manager is told.
                                if (needsAttention > 0) {
                                  toast.warning(t('priorityClaims.inviteQueuedNotRecorded', 'The invitation is queued, but recording it did not complete — it may be offered again. No duplicate email can be sent.'));
                                }
                              } else if (needsAttention > 0) {
                                // The zero-send channel: a suppressed address, or an earlier
                                // invitation for this claim sitting on hold. Both need a human, and
                                // reporting either as "already invited" is how they stay invisible.
                                toast.warning(t('priorityClaims.inviteNeedsAttention', 'This invitation could not be queued and needs attention — the address may be suppressed, or an earlier invitation for this player is on hold.'));
                              } else if ((result?.already ?? 0) > 0) {
                                // NOT NECESSARILY "already responded". Since the enqueue cutover a
                                // skip also means the invitation is ALREADY QUEUED under its
                                // permanent idempotency key — and for a still-pending claim the old
                                // copy was simply false.
                                toast.info(t('priorityClaims.claimNotResent', 'No new invitation was queued — this player has already been invited or has responded.'));
                              } else {
                                toast.error(t('priorityClaims.inviteError', 'Could not send the invitation. Please try again.'));
                              }
                              await reload();
                            } catch (e) {
                              toast.error(getFriendlyErrorMessage(e, t('priorityClaims.inviteError', 'Could not send the invitation. Please try again.')));
                            } finally {
                              setInvitingClaimId(null);
                            }
                          }}
                        >
                          {invitingClaimId === c.id
                            ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                            : <Send className="h-4 w-4 mr-1" />} {t('priorityClaims.invite', 'Invite')}
                        </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={async () => {
                            try {
                              await declineClaimAsManager(c.id);
                              await reload();
                              onChange?.();
                            } catch (e) { toast.error((e as Error).message); }
                          }}
                        >
                          <X className="h-4 w-4 mr-1" /> {t('priorityClaims.release', 'Release')}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {priorityWindowEndsAt && !windowEnded && (
          <div className="flex flex-wrap gap-2 pt-2">
            <Button
              size="sm"
              variant="outline"
              disabled={inviteBusy}
              onClick={async () => {
                setSendingAll(true);
                try {
                  // No resend here: the function only emails pending claims
                  // that were not invited before, so re-clicking is safe.
                  const { data, error } = await supabase.functions.invoke('send-priority-claim-invitation', { body: { slotId } });
                  if (error) throw error;
                  const result = data as {
                    queued?: number; already?: number; suppressed?: number;
                    held?: number; unstamped?: number; failed?: number;
                  } | null;
                  // `failed` counts too. The endpoint answers 200 with a per-claim tally, so a batch
                  // where every claim was REFUSED — no round provenance, for instance — arrives as
                  // {sent:0, failed:N} and used to be reported as "everyone has already been
                  // invited" (review round 3).
                  const stuck = (result?.suppressed ?? 0) + (result?.held ?? 0)
                    + (result?.unstamped ?? 0) + (result?.failed ?? 0);
                  if (((result?.queued ?? 0) + (result?.unstamped ?? 0)) > 0) {
                    toast.success(t('priorityClaims.allQueued', 'Invitations queued for delivery'));
                    // A partial batch still has to name what did NOT queue, or the success toast
                    // buries it.
                    if (stuck > 0) {
                      toast.warning(t('priorityClaims.someNeedAttention', {
                        count: stuck,
                        defaultValue_one: '{{count}} invitation could not be queued and needs attention.',
                        defaultValue_other: '{{count}} invitations could not be queued and need attention.',
                      }));
                    }
                  } else if (stuck > 0) {
                    // Zero queued because every one of them is stuck is NOT "everyone has already
                    // been invited"; that reading is what round 5 found reported as success.
                    toast.warning(t('priorityClaims.someNeedAttention', {
                      count: stuck,
                      defaultValue_one: '{{count}} invitation could not be queued and needs attention.',
                      defaultValue_other: '{{count}} invitations could not be queued and need attention.',
                    }));
                  } else {
                    toast.info(t('priorityClaims.nothingToInvite', 'Everyone has already been invited or responded.'));
                  }
                  await reload();
                } catch (e) {
                  toast.error(getFriendlyErrorMessage(e, t('priorityClaims.inviteError', 'Could not send the invitation. Please try again.')));
                } finally {
                  setSendingAll(false);
                }
              }}
            >
              {sendingAll
                ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                : <Mail className="h-4 w-4 mr-1" />} {t('priorityClaims.inviteAll', 'Send invites')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={extending}
              onClick={async () => {
                setExtending(true);
                try {
                  const result = await extendPriorityWindow(slotId, 7);
                  if (result === 'extended') {
                    toast.success(t('priorityClaims.extended', 'Extended by 7 days'));
                  } else {
                    toast.info(t('priorityClaims.alreadyExtended', 'The window was just extended — no extra days added.'));
                  }
                  await reload();
                  onChange?.();
                } catch (e) {
                  toast.error(getFriendlyErrorMessage(e, t('priorityClaims.extendError', 'Could not extend the window. Please try again.')));
                } finally {
                  setExtending(false);
                }
              }}
            >
              {extending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              + 7 {t('priorityClaims.days', 'days')}
            </Button>
            {/* R16: ending the priority window here jumps straight to public and skips the
                member/second-bucket tier — confirm first. */}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="outline">
                  <Globe className="h-4 w-4 mr-1" /> {t('priorityClaims.openNow', 'Open to public now')}
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
                  <AlertDialogAction
                    onClick={async () => {
                      try { await endPriorityWindowNow(slotId); toast.success(t('priorityClaims.openedToPublic', 'Opened to public')); onChange?.(); }
                      catch (e) { toast.error((e as Error).message); }
                    }}
                  >
                    {t('tierControl.openPublicConfirmAction', 'Ja, voor iedereen openzetten')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
