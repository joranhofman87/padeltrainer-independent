import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { StatTile, type StatTileProps } from '@/components/ui/stat-tile';
import { pctDelta } from '@/lib/dashboardAnalytics';
import { cn } from '@/lib/utils';

interface KpiTileProps extends Omit<StatTileProps, 'subtext' | 'value'> {
  value: ReactNode;
  current: number;
  previous: number;
  /** true = an increase is good (revenue, players); false = an increase is bad (expenses). */
  upIsGood?: boolean;
}

/** StatTile + a coloured % delta vs the prior month (green/red by up-is-good). No delta when
 *  there's no prior baseline (avoids a misleading ∞%). */
export function KpiTile({ value, current, previous, upIsGood = true, ...rest }: KpiTileProps) {
  const { t } = useTranslation('common');
  const delta = pctDelta(current, previous);
  let subtext: ReactNode = null;
  if (delta !== null) {
    const up = delta >= 0;
    const good = up === upIsGood;
    const Icon = up ? ArrowUpRight : ArrowDownRight;
    subtext = (
      <span className={cn('inline-flex items-center gap-0.5', good ? 'text-emerald-600' : 'text-rose-600')}>
        <Icon className="h-3 w-3" />
        {Math.abs(delta).toFixed(0)}% {t('dashboard.vsLastMonth', 'vs vorige maand')}
      </span>
    );
  }
  return <StatTile value={value} subtext={subtext} {...rest} />;
}
