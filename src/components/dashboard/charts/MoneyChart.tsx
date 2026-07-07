import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { Bar, ComposedChart, Line, XAxis, YAxis, CartesianGrid } from 'recharts';
import { formatCurrency } from '@/lib/format';
import type { MonthlyPoint } from '@/lib/dashboardAnalytics';

const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-');
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('nl-NL', { month: 'short' });
};

/** Money in vs out over the last N months, with a profit line. */
export function MoneyChart({ data }: { data: MonthlyPoint[] }) {
  const { t } = useTranslation('common');
  const config = {
    revenue: { label: t('dashboard.money.revenue', 'Inkomsten'), color: 'hsl(var(--chart-2))' },
    expenses: { label: t('dashboard.money.expenses', 'Uitgaven'), color: 'hsl(var(--chart-5))' },
    profit: { label: t('dashboard.money.profit', 'Winst'), color: 'hsl(var(--primary))' },
  };
  const rows = data.map((d) => ({ ...d, label: monthLabel(d.ym) }));
  const hasData = data.some((d) => d.revenue || d.expenses);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('dashboard.money.title', 'Inkomsten & uitgaven')}</CardTitle>
      </CardHeader>
      <CardContent>
        {hasData ? (
          <ChartContainer config={config} className="h-[280px] w-full">
            <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis tickFormatter={(v) => formatCurrency(Number(v))} width={64} tickLine={false} axisLine={false} fontSize={11} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="revenue" fill="var(--color-revenue)" radius={[3, 3, 0, 0]} name={config.revenue.label} />
              <Bar dataKey="expenses" fill="var(--color-expenses)" radius={[3, 3, 0, 0]} name={config.expenses.label} />
              <Line type="monotone" dataKey="profit" stroke="var(--color-profit)" strokeWidth={2} dot={false} name={config.profit.label} />
            </ComposedChart>
          </ChartContainer>
        ) : (
          <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
            {t('dashboard.money.empty', 'Nog geen inkomsten of uitgaven om te tonen.')}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
