import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import type { PlayerScope } from '@/lib/playerQueryKeys';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { PLAYER_MERGE_UNAVAILABLE_I18N, isPlayerMergeAvailable } from '@/lib/playerMergeAvailability';

/**
 * Pass B §4 — player merge is unavailable.
 *
 * This used to search for a candidate, let the manager pick which side's field values to keep,
 * and then call the `merge_guest_players` RPC, which moved bookings and invoices and deleted the
 * losing row. The RPC is retired: the evidence that justified declaring two guest rows to be one
 * human — matching name, matching email, the legacy account bridge — is exactly what this
 * containment withdrew, and the operation cannot be undone from the UI.
 *
 * What replaced it is an explicit unavailable state, not a hidden or disabled control. The
 * candidate search, the field chooser and the confirm action are GONE, so there is nothing to
 * reach by keyboard, by Enter on a form, or by a test that clicks a hidden node. No request is
 * issued, nothing optimistic is written, and success is never reported.
 *
 * The props are unchanged so both detail pages keep compiling; `onMerged` is now never called,
 * which is the point — there is no merge to report.
 */
interface MergePlayersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: PlayerScope;
  currentPlayer: { guestPlayerId: string; full_name: string };
  /** Retained for signature compatibility. Never called: no merge can occur. */
  onMerged: (targetGuestId: string) => void;
}

export function MergePlayersDialog({
  open,
  onOpenChange,
  scope: _scope,
  currentPlayer: _currentPlayer,
  onMerged: _onMerged,
}: MergePlayersDialogProps) {
  const { t } = useTranslation('trainer');

  // A capability check rather than a bare constant, so restoring merge behind real evidence is a
  // one-line change in one module. It is false today, and this component renders nothing else.
  const available = isPlayerMergeAvailable();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="merge-players-dialog">
        <DialogHeader>
          <DialogTitle>
            {t(PLAYER_MERGE_UNAVAILABLE_I18N.titleKey, PLAYER_MERGE_UNAVAILABLE_I18N.titleDefault)}
          </DialogTitle>
          <DialogDescription>
            {t(PLAYER_MERGE_UNAVAILABLE_I18N.bodyKey, PLAYER_MERGE_UNAVAILABLE_I18N.bodyDefault)}
          </DialogDescription>
        </DialogHeader>

        {!available && (
          <Alert data-testid="merge-unavailable">
            <Info className="h-4 w-4" />
            <AlertDescription className="text-xs">
              {t(
                'players.merge.unavailableHint',
                'Nothing has been changed or deleted. Both players are still there, with their own trainings and invoices.',
              )}
            </AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('players.merge.close', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
