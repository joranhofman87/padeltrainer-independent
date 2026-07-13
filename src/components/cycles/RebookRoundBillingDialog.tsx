import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import type { RebookPaymentMode } from '@/lib/priorityClaims';
import type { CycleBookingMode } from '@/lib/cycleBookingMode';
import { updateRoundPaymentMode, updateRoundPublicOpenMode, type RoundSettingsResult } from '@/lib/rebookRoundSettings';
import { RebookPaymentModeField } from './RebookPaymentModeField';
import { RebookPublicOpenModeField, type PublicOpenMode } from './RebookPublicOpenModeField';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** All cycle ids of the round (RebookManageData.cycleIds) — the edit is round-wide. */
  cycleIds: string[];
  academyProfileId: string;
  currentPaymentMode: RebookPaymentMode;
  currentStrictMollie: boolean;
  currentPublicOpenMode: CycleBookingMode;
  currentPublicOpenSplit: boolean;
  onSaved?: () => void;
}

/**
 * Edit a rebook round's payment settings AFTER it was sent: how returning players pay (upfront vs
 * invoice-split) AND how the public pays once non-rebooked sessions open. Both are written round-wide
 * via rebookRoundSettings. Returning-payment changes affect FUTURE accepts only.
 */
export function RebookRoundBillingDialog({
  open, onOpenChange, cycleIds, academyProfileId,
  currentPaymentMode, currentStrictMollie, currentPublicOpenMode, currentPublicOpenSplit, onSaved,
}: Props) {
  const { t } = useTranslation('cycles');
  const [saving, setSaving] = useState(false);
  const [paymentMode, setPaymentMode] = useState<RebookPaymentMode>(currentPaymentMode);
  const [strictMollie, setStrictMollie] = useState(currentStrictMollie);
  const [publicOpenMode, setPublicOpenMode] = useState<CycleBookingMode>(currentPublicOpenMode);
  const [publicOpenSplit, setPublicOpenSplit] = useState(currentPublicOpenSplit);

  useEffect(() => {
    if (!open) return;
    setPaymentMode(currentPaymentMode);
    setStrictMollie(currentStrictMollie);
    setPublicOpenMode(currentPublicOpenMode);
    setPublicOpenSplit(currentPublicOpenSplit);
  }, [open, currentPaymentMode, currentStrictMollie, currentPublicOpenMode, currentPublicOpenSplit]);

  const onSave = async () => {
    if (saving || cycleIds.length === 0) return;
    setSaving(true);
    try {
      const [pay, open2] = await Promise.all([
        updateRoundPaymentMode(cycleIds, paymentMode, strictMollie),
        updateRoundPublicOpenMode(cycleIds, publicOpenMode, publicOpenSplit),
      ]);
      const fails = [...pay.failed, ...open2.failed];
      if (fails.length > 0) {
        toast.error(t('rebookManage.billingPartialFail', 'Niet alles kon worden aangepast — probeer het opnieuw.'));
        return;
      }
      toast.success(t('rebookManage.billingSaved', 'Betaalinstellingen aangepast'));
      onOpenChange(false);
      onSaved?.();
    } catch (e) {
      toast.error(getFriendlyErrorMessage(e, t('rebookManage.billingErrSave', 'Aanpassen mislukt. Probeer het opnieuw.')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!saving) onOpenChange(v); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('rebookManage.billingTitle', 'Betaling aanpassen')}</DialogTitle>
          <DialogDescription>
            {t('rebookManage.billingDescription', 'Geldt voor de hele ronde. Een gewijzigde betaalwijze voor terugkerende spelers geldt alleen voor spelers die daarna nog bevestigen; wie al betaalde of een factuur kreeg, houdt zijn oorspronkelijke voorwaarden.')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <RebookPaymentModeField
            academyProfileId={academyProfileId}
            paymentMode={paymentMode}
            setPaymentMode={setPaymentMode}
            strictMollie={strictMollie}
            setStrictMollie={setStrictMollie}
          />
          <RebookPublicOpenModeField
            mode={publicOpenMode}
            setMode={(m: PublicOpenMode) => { if (m !== 'inherit') setPublicOpenMode(m); }}
            split={publicOpenSplit}
            setSplit={setPublicOpenSplit}
            hideInherit
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common:cancel', 'Annuleren')}
          </Button>
          <Button onClick={onSave} disabled={saving || cycleIds.length === 0}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {saving ? t('common:saving', 'Bezig...') : t('common:save', 'Opslaan')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type { RoundSettingsResult };
