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
  // Both paths email the same claimants; block one while the other runs.
  const inviteBusy = invitingClaimId !== null || sendingAll;

  const reload = async () => {
    setLoading(true);
    try {
      const [claimsData, slot] = await Promise.all([
        getPriorityClaimsForSlot(slotId),
        supabase.from('availability_slots').select('priority_window_ends_at').eq('id', slotId).maybeSingle(),
      ]);
      setClaims(claimsData as unknown as ClaimRow[]);
      setPriorityWindowEndsAt(slot.data?.priority_window_ends_at ?? null);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, [slotId]);

  if (loading) return null;
  if (claims.length === 0 && !priorityWindowEndsAt) return null;

  const windowEnded = priorityWindowEndsAt && new Date(priorityWindowEndsAt) < new Date();

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
                              const result = data as { sent?: number; skipped?: number } | null;
                              if ((result?.sent ?? 0) > 0) {
                                toast.success(t('priorityClaims.invitationSent', 'Invitation sent'));
                              } else if ((result?.skipped ?? 0) > 0) {
                                toast.info(t('priorityClaims.claimAlreadyResponded', 'This player has already responded — no invitation sent.'));
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
                  const result = data as { sent?: number; skipped?: number } | null;
                  if ((result?.sent ?? 0) > 0) {
                    toast.success(t('priorityClaims.allInvited', 'Invitations sent'));
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
