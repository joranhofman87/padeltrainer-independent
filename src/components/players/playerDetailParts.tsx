// Shared presentational helpers for the trainer + academy player-detail pages (role-page de-dup,
// behavior-frozen). These existed as functionally-identical copies in TrainerPlayerDetail and
// AcademyPlayerDetail; the canonical (typed) variants are kept and the SVG gradient id is unified
// (the two pages never render together) — the rendered output is unchanged.
import type { ReactNode } from 'react';
import { format } from 'date-fns';
import { BarChart3, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, CartesianGrid, XAxis, YAxis, Tooltip as RTooltip } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export interface RatingPoint {
  date: string;
  rating: number;
  source: string;
}

export function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
    </div>
  );
}

export function Empty({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="py-12 flex flex-col items-center text-muted-foreground">
      {icon}
      <p className="mt-2 text-sm">{text}</p>
    </div>
  );
}

export function InvoiceStatus({ status }: { status: string | null }) {
  const variant = status === 'paid' ? 'default' : status === 'overdue' ? 'destructive' : 'secondary';
  return <Badge variant={variant as 'default' | 'destructive' | 'secondary'}>{status || 'draft'}</Badge>;
}

export function RatingTrendCard({
  history,
  ratingSystem,
  currentRating,
  isGuest,
  t,
}: {
  history: RatingPoint[];
  ratingSystem: string | null;
  currentRating: number | null;
  isGuest: boolean;
  t: (key: string, fallback?: string) => string;
}) {
  const lowerIsBetter = (ratingSystem || 'knltb').toLowerCase() === 'knltb';
  const systemLabel = (ratingSystem || 'knltb').toUpperCase();

  if (!history || history.length < 2) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 className="h-4 w-4" /> {t('players.detail.ratingProgress', 'Rating progress')}
            <span className="text-xs font-normal text-muted-foreground">({systemLabel})</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {isGuest
              ? t('players.detail.ratingGuestHint', 'Rating history is tracked for registered players.')
              : t('players.detail.ratingNotEnough', 'Not enough rating history to show a trend yet.')}
            {currentRating != null && (
              <span className="ml-1">
                {t('players.detail.currentRating', 'Current')}:{' '}
                <span className="font-semibold text-foreground">{currentRating.toFixed(1)}</span>
              </span>
            )}
          </p>
        </CardContent>
      </Card>
    );
  }

  const first = history[0].rating;
  const latest = history[history.length - 1].rating;
  const rawDiff = Number((first - latest).toFixed(2));
  const improvement = lowerIsBetter ? rawDiff : -rawDiff;
  const improved = improvement > 0;
  const declined = improvement < 0;
  const best = lowerIsBetter
    ? Math.min(...history.map((h) => h.rating))
    : Math.max(...history.map((h) => h.rating));

  const chartData = history.map((r) => ({
    label: format(new Date(r.date), 'MMM yyyy'),
    rating: r.rating,
  }));

  const trendColor = improved
    ? 'text-green-600 dark:text-green-400'
    : declined
      ? 'text-red-600 dark:text-red-400'
      : 'text-muted-foreground';
  const TrendIcon = improved ? TrendingUp : declined ? TrendingDown : Minus;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendIcon className={cn('h-4 w-4', trendColor)} />
            {t('players.detail.ratingProgress', 'Rating progress')}
            <span className="text-xs font-normal text-muted-foreground">({systemLabel})</span>
          </CardTitle>
          {improvement !== 0 && (
            <span className={cn('text-sm font-semibold', trendColor)}>
              {improvement > 0 ? '+' : ''}
              {improvement.toFixed(1)} {t('players.detail.points', 'points')}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-md bg-muted/50 p-3 text-center">
            <p className="text-xs text-muted-foreground">{t('players.detail.started', 'Started')}</p>
            <p className="text-lg font-semibold font-mono">{first.toFixed(1)}</p>
          </div>
          <div className="rounded-md bg-muted/50 p-3 text-center">
            <p className="text-xs text-muted-foreground">{t('players.detail.current', 'Current')}</p>
            <p className="text-lg font-semibold font-mono">{latest.toFixed(1)}</p>
          </div>
          <div className="rounded-md bg-primary/10 p-3 text-center">
            <p className="text-xs text-muted-foreground">{t('players.detail.best', 'Best')}</p>
            <p className="text-lg font-semibold font-mono text-primary">{best.toFixed(1)}</p>
          </div>
        </div>
        <div className="h-28">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="playerRatingGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} domain={['auto', 'auto']} reversed={lowerIsBetter} width={30} />
              <RTooltip />
              <Area
                type="monotone"
                dataKey="rating"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                fill="url(#playerRatingGradient)"
                dot={false}
                activeDot={{ r: 4 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
