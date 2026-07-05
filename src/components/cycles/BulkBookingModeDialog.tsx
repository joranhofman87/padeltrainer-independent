/**
 * Bulk "Boekbaarheid" dialog — pick how the selected cycli sell (the four pay modes) and
 * apply cycle-wide via setCycleBookingMode. Shared by the academy cyclus overview and the
 * trainer schedule overview (same 'trainer' i18n namespace on both pages).
 *
 * The mode choice deliberately starts EMPTY: a mixed selection has no single current mode.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';
import type { CycleBookingMode } from '@/lib/cycleBookingMode';

export function BulkBookingModeDialog({
  open,
  onOpenChange,
  selectedCount,
  busy,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedCount: number;
  busy: boolean;
  onApply: (mode: CycleBookingMode) => void | Promise<void>;
}) {
  const { t } = useTranslation('trainer');
  const [mode, setMode] = useState<CycleBookingMode | ''>('');

  const close = (o: boolean) => {
    if (busy) return;
    onOpenChange(o);
    if (!o) setMode('');
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('cyclesTab.bulkBooking.title', { count: selectedCount })}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <RadioGroup value={mode} onValueChange={(v) => setMode(v as CycleBookingMode)}>
            {([
              ['both', t('cyclesTab.bulkBooking.modeBoth'), t('cyclesTab.bulkBooking.modeBothHelp')],
              ['single_only', t('cyclesTab.bulkBooking.modeSingleOnly'), t('cyclesTab.bulkBooking.modeSingleOnlyHelp')],
              ['single_only_whole_slot', t('cyclesTab.bulkBooking.modeSingleOnlyWholeSlot'), t('cyclesTab.bulkBooking.modeSingleOnlyWholeSlotHelp')],
              ['cyclus_only', t('cyclesTab.bulkBooking.modeCyclusOnly'), t('cyclesTab.bulkBooking.modeCyclusOnlyHelp')],
            ] as const).map(([value, label, help]) => (
              <label
                key={value}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
                  mode === value ? 'border-primary bg-primary/5' : 'hover:bg-muted',
                )}
              >
                <RadioGroupItem value={value} className="mt-0.5" />
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="block text-xs text-muted-foreground">{help}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
          <p className="text-xs text-muted-foreground">{t('cyclesTab.bulkBooking.scopeNote')}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={busy}>
            {t('cyclesTab.cancel')}
          </Button>
          <Button onClick={() => mode && onApply(mode)} disabled={busy || !mode}>
            {busy ? t('cyclesTab.saving') : t('cyclesTab.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
