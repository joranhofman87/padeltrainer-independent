import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { CycleBookingMode } from '@/lib/cycleBookingMode';

/**
 * How a rebook round's NON-rebooked sessions should be bookable once they OPEN to the public
 * at the deadline — the explicit control that replaces silently copying the source court's flags
 * (which let a split source court open per-seat unnoticed). 'inherit' keeps that copy behaviour
 * (default, zero change); any explicit mode overrides every series in the round uniformly.
 */
export type PublicOpenMode = CycleBookingMode | 'inherit';

interface Props {
  mode: PublicOpenMode;
  setMode: (m: PublicOpenMode) => void;
  /** Split the price across the players. Ignored for whole-court + inherit (edge enforces this too). */
  split: boolean;
  setSplit: (b: boolean) => void;
  /** Cohort wizard spans many source courts → no single "current" value to show as context. */
  multiSource?: boolean;
}

// Split only makes sense for per-seat / whole-cycle selling; whole-court is one payment by
// definition, and 'inherit' carries the source's own split flag.
const SPLIT_MODES: PublicOpenMode[] = ['both', 'single_only', 'cyclus_only'];

// The reusable per-mode help copy already written for the slot generator / booking-mode dialog.
const MODE_HELP: Record<CycleBookingMode, string> = {
  both: 'cyclesTab.bulkBooking.modeBothHelp',
  single_only: 'cyclesTab.bulkBooking.modeSingleOnlyHelp',
  single_only_whole_slot: 'cyclesTab.bulkBooking.modeSingleOnlyWholeSlotHelp',
  cyclus_only: 'cyclesTab.bulkBooking.modeCyclusOnlyHelp',
};

export function RebookPublicOpenModeField({ mode, setMode, split, setSplit, multiSource }: Props) {
  const { t } = useTranslation('cycles');
  const showSplit = SPLIT_MODES.includes(mode);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('rebookShared.publicOpenTitle', 'Als sessies opengaan voor publiek')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <Label>{t('rebookShared.publicOpenLabel', 'Hoe kan het publiek een vrijgekomen sessie boeken?')}</Label>
        <Select value={mode} onValueChange={(v) => setMode(v as PublicOpenMode)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">{t('rebookShared.publicOpenInherit', 'Zelfde als de oorspronkelijke baan (overnemen)')}</SelectItem>
            <SelectItem value="both">{t('cyclesTab.bulkBooking.modeBoth', 'Losse sessies én hele cyclus', { ns: 'trainer' })}</SelectItem>
            <SelectItem value="single_only">{t('cyclesTab.bulkBooking.modeSingleOnly', 'Alleen losse sessies (per plek)', { ns: 'trainer' })}</SelectItem>
            <SelectItem value="single_only_whole_slot">{t('cyclesTab.bulkBooking.modeSingleOnlyWholeSlot', 'Alleen losse sessies (hele baan per boeking)', { ns: 'trainer' })}</SelectItem>
            <SelectItem value="cyclus_only">{t('cyclesTab.bulkBooking.modeCyclusOnly', 'Alleen hele cyclus', { ns: 'trainer' })}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {mode === 'inherit'
            ? (multiSource
                ? t('rebookShared.publicOpenInheritHelpMulti', 'Elke vrijgekomen sessie erft de instelling van zijn eigen oorspronkelijke baan.')
                : t('rebookShared.publicOpenInheritHelp', 'De vrijgekomen sessies erven de instelling van de oorspronkelijke baan.'))
            : t(MODE_HELP[mode], { ns: 'trainer' })}
        </p>
        {showSplit && (
          <label className="flex items-start gap-2 pt-1 text-sm cursor-pointer">
            <input type="checkbox" className="mt-1" checked={split} onChange={(e) => setSplit(e.target.checked)} />
            <span>{t('rebookShared.publicOpenSplit', 'Prijs splitsen over de spelers (elke speler betaalt zijn eigen deel)')}</span>
          </label>
        )}
      </CardContent>
    </Card>
  );
}
