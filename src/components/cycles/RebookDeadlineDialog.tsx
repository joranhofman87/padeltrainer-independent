import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { DatePickerPopover } from '@/components/ui/date-picker-popover';
import { TimeSelect } from '@/components/ui/time-select';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { localWallTimeToUtc } from '@/lib/slotPlan';
import { formatZonedTime, zonedDateKey } from '@/lib/zonedFormat';
import { updateRoundPriorityDeadline } from '@/lib/rebookRoundDeadline';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** All cycle ids of the round (RebookManageData.cycleIds) — the edit is round-wide. */
  cycleIds: string[];
  /** The round's current deadline (UTC ISO) for prefill; null when unknown. */
  currentDeadline: string | null;
  /** Academy IANA timezone — the picked date + hour are that academy's wall-clock time. */
  timezone: string;
  onSaved?: () => void;
}

// The expire cron runs every 15 min and stamps pending claims 'expired' the moment the
// deadline is in the past — require a small future buffer so an edit can never race it.
const MIN_FUTURE_MS = 10 * 60 * 1000;

/**
 * Change a rebook round's priority deadline (date + exact time, academy timezone) after the
 * round was sent. Applies to every group except ones already RELEASED to the public; expired
 * invitations are re-opened so the extension actually works (see rebookRoundDeadline.ts).
 */
export function RebookDeadlineDialog({ open, onOpenChange, cycleIds, currentDeadline, timezone, onSaved }: Props) {
  const { t } = useTranslation('cycles');
  const [saving, setSaving] = useState(false);
  const [date, setDate] = useState<Date | undefined>(undefined);
  const [time, setTime] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    // Prefill with the current deadline's ACADEMY-timezone calendar day + wall-clock time.
    if (currentDeadline) {
      const [y, m, d] = zonedDateKey(currentDeadline, timezone).split('-').map(Number);
      setDate(new Date(y, m - 1, d));
      setTime(formatZonedTime(currentDeadline, timezone));
    } else {
      setDate(undefined);
      setTime(undefined);
    }
  }, [open, currentDeadline, timezone]);

  const targetIso = useMemo(() => {
    if (!date || !time) return null;
    const [h, mi] = time.split(':').map(Number);
    return localWallTimeToUtc(date.getFullYear(), date.getMonth(), date.getDate(), h, mi, timezone).toISOString();
  }, [date, time, timezone]);

  const tooSoon = targetIso != null && new Date(targetIso).getTime() < Date.now() + MIN_FUTURE_MS;

  const onSave = async () => {
    if (saving || !targetIso || tooSoon) return;
    setSaving(true);
    try {
      const res = await updateRoundPriorityDeadline(cycleIds, targetIso);
      if (res.failed.length > 0) {
        // Partial write = groups with different deadlines; keep the dialog open so a retry
        // can finish the job (targets are absolute — a retry converges).
        toast.error(t('rebookManage.deadlinePartialFail', '{{ok}} sessies aangepast, {{fail}} mislukt — probeer het opnieuw.', {
          ok: res.updatedSlots, fail: res.failed.reduce((n, f) => n + f.ids.length, 0),
        }));
        return;
      }
      const revived = res.revivedClaims > 0
        ? ' ' + t('rebookManage.deadlineRevived', '· {{count}} verlopen uitnodigingen heropend', { count: res.revivedClaims })
        : '';
      const skipped = res.skippedReleasedSlots > 0
        ? ' ' + t('rebookManage.deadlineSkipped', '({{count}} al opengezette sessies overgeslagen)', { count: res.skippedReleasedSlots })
        : '';
      toast.success(t('rebookManage.deadlineSaved', 'Reactietermijn aangepast voor {{count}} sessies', { count: res.updatedSlots }) + revived + skipped);
      onOpenChange(false);
      onSaved?.();
    } catch (e) {
      toast.error(getFriendlyErrorMessage(e, t('rebookManage.deadlineErrSave', 'Aanpassen mislukt. Probeer het opnieuw.')));
    } finally {
      setSaving(false);
    }
  };

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!saving) onOpenChange(v); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('rebookManage.deadlineTitle', 'Reactietermijn aanpassen')}</DialogTitle>
          <DialogDescription>
            {t('rebookManage.deadlineDescription', 'Geldt voor alle groepen in deze ronde, behalve groepen die je al voor iedereen hebt opengezet. Spelers van wie de uitnodiging was verlopen, kunnen na verlengen weer reageren via hun bestaande link. Al verstuurde e-mails en herinneringen worden niet opnieuw verzonden; het venster voor vaste spelers schuift automatisch mee.')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="rebook-deadline-date">{t('rebookManage.deadlineDateLabel', 'Datum')}</Label>
            <DatePickerPopover
              id="rebook-deadline-date"
              value={date}
              onChange={(d) => d && setDate(d)}
              disabled={(d) => d < startOfToday}
              triggerDisabled={saving}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rebook-deadline-time">{t('rebookManage.deadlineTimeLabel', 'Tijd')}</Label>
            <TimeSelect
              id="rebook-deadline-time"
              value={time}
              onValueChange={setTime}
              disabled={saving}
              triggerClassName="w-[110px]"
              ariaLabel={t('rebookManage.deadlineTimeLabel', 'Tijd')}
            />
          </div>
        </div>
        {tooSoon && (
          <p className="text-sm text-destructive">{t('rebookManage.deadlineTooSoon', 'Kies een moment in de toekomst.')}</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common:cancel', 'Annuleren')}
          </Button>
          <Button onClick={onSave} disabled={saving || !targetIso || tooSoon || cycleIds.length === 0}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {saving ? t('common:saving', 'Bezig...') : t('rebookManage.deadlineSave', 'Termijn aanpassen')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
