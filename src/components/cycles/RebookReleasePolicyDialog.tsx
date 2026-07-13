import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { updateRoundReleasePolicy, type ReleasePolicy, type ReleasePolicyState } from '@/lib/rebookRoundSettings';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** All cycle ids of the round (RebookManageData.cycleIds) — the edit is round-wide. */
  cycleIds: string[];
  currentPolicy: ReleasePolicyState;
  onSaved?: () => void;
}

/**
 * Round-wide policy for what happens to non-rebooked sessions at the deadline: auto-open to the
 * public (`auto_release_scheduled`) or stay private/held until the admin releases them. Slots already
 * force-opened ('released') are left untouched.
 */
export function RebookReleasePolicyDialog({ open, onOpenChange, cycleIds, currentPolicy, onSaved }: Props) {
  const { t } = useTranslation('cycles');
  const [saving, setSaving] = useState(false);
  // 'mixed' has no single truthful value → default the radio to 'auto' (the safe, opens-eventually choice).
  const [policy, setPolicy] = useState<ReleasePolicy>(currentPolicy === 'private' ? 'private' : 'auto');

  useEffect(() => {
    if (!open) return;
    setPolicy(currentPolicy === 'private' ? 'private' : 'auto');
  }, [open, currentPolicy]);

  const onSave = async () => {
    if (saving || cycleIds.length === 0) return;
    setSaving(true);
    try {
      const res = await updateRoundReleasePolicy(cycleIds, policy);
      if (res.failed.length > 0) {
        toast.error(t('rebookManage.releasePartialFail', 'Niet alle sessies konden worden aangepast — probeer het opnieuw.'));
        return;
      }
      const skipped = res.skippedReleasedSlots > 0
        ? ' ' + t('rebookManage.releaseSkipped', '({{count}} al opengezette sessies overgeslagen)', { count: res.skippedReleasedSlots })
        : '';
      toast.success(
        (policy === 'auto'
          ? t('rebookManage.releaseSavedAuto', 'Sessies gaan automatisch open na de deadline')
          : t('rebookManage.releaseSavedPrivate', 'Sessies blijven privé tot je ze zelf vrijgeeft')) + skipped,
      );
      onOpenChange(false);
      onSaved?.();
    } catch (e) {
      toast.error(getFriendlyErrorMessage(e, t('rebookManage.releaseErrSave', 'Aanpassen mislukt. Probeer het opnieuw.')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!saving) onOpenChange(v); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('rebookManage.releaseTitle', 'Publiek vrijgeven')}</DialogTitle>
          <DialogDescription>
            {t('rebookManage.releaseDescription', 'Wat gebeurt er met niet-herboekte sessies zodra de deadline voorbij is? Geldt voor de hele ronde. Sessies die je al voor iedereen hebt opengezet blijven open.')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label className="flex items-start gap-2 rounded-md border p-3 text-sm cursor-pointer">
            <input type="radio" className="mt-1" checked={policy === 'auto'} onChange={() => setPolicy('auto')} />
            <span>
              <span className="font-medium">{t('rebookManage.releaseOptAuto', 'Automatisch openstellen')}</span>
              <span className="block text-xs text-muted-foreground">{t('rebookManage.releaseOptAutoHint', 'Na de deadline komen vrije sessies automatisch beschikbaar voor het publiek.')}</span>
            </span>
          </label>
          <label className="flex items-start gap-2 rounded-md border p-3 text-sm cursor-pointer">
            <input type="radio" className="mt-1" checked={policy === 'private'} onChange={() => setPolicy('private')} />
            <span>
              <span className="font-medium">{t('rebookManage.releaseOptPrivate', 'Privé houden')}</span>
              <span className="block text-xs text-muted-foreground">{t('rebookManage.releaseOptPrivateHint', 'Sessies blijven verborgen tot je ze zelf vrijgeeft.')}</span>
            </span>
          </label>
          {currentPolicy === 'mixed' && (
            <p className="text-xs text-muted-foreground">{t('rebookManage.releaseMixedHint', 'De sessies in deze ronde staan nu verschillend ingesteld; je keuze geldt voor allemaal.')}</p>
          )}
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
