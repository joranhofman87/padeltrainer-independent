import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { Bar, BarChart, XAxis, YAxis, CartesianGrid } from 'recharts';
import type { MonthlyPoint } from '@/lib/dashboardAnalytics';

const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-');
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('nl-NL', { month: 'short' });
};

/** New players per month, stacked registered vs guest. */
export function NewPlayersChart({ data }: { data: MonthlyPoint[] }) {
  const { t } = useTranslation('common');
  const config = {
    new_registered: { label: t('dashboard.players.registered', 'Geregistreerd'), color: 'hsl(var(--primary))' },
    new_guest: { label: t('dashboard.players.guest', 'Gast'), color: 'hsl(var(--chart-4))' },
  };
  const rows = data.map((d) => ({ ...d, label: monthLabel(d.ym) }));
  const hasData = data.some((d) => d.new_registered || d.new_guest);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('dashboard.players.title', 'Nieuwe spelers')}</CardTitle>
      </CardHeader>
      <CardContent>
        {hasData ? (
          <ChartContainer config={config} className="h-[280px] w-full">
            <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis allowDecimals={false} width={32} tickLine={false} axisLine={false} fontSize={11} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="new_registered" stackId="p" fill="var(--color-new_registered)" radius={[0, 0, 0, 0]} name={config.new_registered.label} />
              <Bar dataKey="new_guest" stackId="p" fill="var(--color-new_guest)" radius={[3, 3, 0, 0]} name={config.new_guest.label} />
            </BarChart>
          </ChartContainer>
        ) : (
          <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
            {t('dashboard.players.empty', 'Nog geen nieuwe spelers om te tonen.')}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
