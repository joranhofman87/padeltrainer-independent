import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { LineChart, Line, XAxis, YAxis, CartesianGrid } from 'recharts';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabaseClient';
import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { getRatingSystemByCode, RatingSystemConfig } from '@/lib/ratingSystems';

interface RatingHistoryEntry {
  id: string;
  rating: number;
  rating_system: string;
  source: string;
  scraped_at: string;
}

interface RatingHistoryChartProps {
  profileId: string;
  currentRating: number | null;
  ratingSystem: string;
}

const chartConfig = {
  rating: {
    label: 'Rating',
    color: 'hsl(var(--primary))',
  },
};

export function RatingHistoryChart({ 
  profileId, 
  currentRating, 
  ratingSystem 
}: RatingHistoryChartProps) {
  const { t } = useTranslation('player');
  const [history, setHistory] = useState<RatingHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [systemConfig, setSystemConfig] = useState<RatingSystemConfig | null>(null);

  useEffect(() => {
    fetchHistory();
    fetchSystemConfig();
  }, [profileId, ratingSystem]);

  const fetchSystemConfig = async () => {
    const config = await getRatingSystemByCode(ratingSystem);
    setSystemConfig(config);
  };

  const fetchHistory = async () => {
    if (!profileId) return;
    
    setLoading(true);
    try {
      // Filter by rating system to show per-system history
      const { data, error } = await supabase
        .from('player_rating_history')
        .select('*')
        .eq('profile_id', profileId)
        .eq('rating_system', ratingSystem)
        .order('scraped_at', { ascending: true });

      if (error) {
        console.error('Error fetching rating history:', error);
      } else {
        setHistory(data || []);
      }
    } catch (err) {
      console.error('Failed to fetch history:', err);
    } finally {
      setLoading(false);
    }
  };

  // Calculate improvement based on rating system direction
  const firstRating = history.length > 0 ? history[0].rating : null;
  const latestRating = history.length > 0 ? history[history.length - 1].rating : currentRating;
  const rawDifference = firstRating && latestRating ? Number((firstRating - latestRating).toFixed(2)) : 0;
  
  // Determine if player improved based on rating system rules
  const lowerIsBetter = systemConfig?.lower_is_better ?? (ratingSystem === 'knltb');
  const improvement = lowerIsBetter ? rawDifference : -rawDifference;
  const hasImproved = improvement > 0;
  const hasDeclined = improvement < 0;

  // Format data for chart
  const chartData = history.map(entry => ({
    date: format(new Date(entry.scraped_at), 'MMM d'),
    fullDate: format(new Date(entry.scraped_at), 'MMM d, yyyy'),
    rating: entry.rating,
    source: 'Manual',
  }));

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-center h-32">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (history.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-primary" />
            {t('ratingHistory.title', 'Rating Progress')}
            {systemConfig && (
              <span className="text-sm font-normal text-muted-foreground">
                ({systemConfig.name})
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6 text-muted-foreground">
            <p>{t('ratingHistory.noData', 'No rating history yet')}</p>
            <p className="text-sm mt-1">
              {t('ratingHistory.noDataDescription', 'Your rating history will appear here as it updates')}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          {hasImproved ? (
            <TrendingUp className="h-5 w-5 text-green-500" />
          ) : hasDeclined ? (
            <TrendingDown className="h-5 w-5 text-red-500" />
          ) : (
            <Minus className="h-5 w-5 text-muted-foreground" />
          )}
          {t('ratingHistory.title', 'Rating Progress')}
          {systemConfig && (
            <span className="text-sm font-normal text-muted-foreground">
              ({systemConfig.name})
            </span>
          )}
        </CardTitle>
        <CardDescription>
          {t('ratingHistory.trackingDescription', 'Tracking your padel improvement over time')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* Stats row */}
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div className="text-center p-3 bg-muted/50 rounded-lg">
            <p className="text-xs text-muted-foreground">{t('ratingHistory.started', 'Started')}</p>
            <p className="text-lg font-bold">{firstRating || '—'}</p>
          </div>
          <div className="text-center p-3 bg-muted/50 rounded-lg">
            <p className="text-xs text-muted-foreground">{t('ratingHistory.current', 'Current')}</p>
            <p className="text-lg font-bold">{latestRating || '—'}</p>
          </div>
          <div className={`text-center p-3 rounded-lg ${
            hasImproved ? 'bg-green-100 dark:bg-green-900/30' : 
            hasDeclined ? 'bg-red-100 dark:bg-red-900/30' : 
            'bg-muted/50'
          }`}>
            <p className="text-xs text-muted-foreground">{t('ratingHistory.improvement', 'Improvement')}</p>
            <p className={`text-lg font-bold ${
              hasImproved ? 'text-green-600 dark:text-green-400' : 
              hasDeclined ? 'text-red-600 dark:text-red-400' : ''
            }`}>
              {improvement !== 0 ? (improvement > 0 ? '+' : '') + improvement : '—'}
            </p>
          </div>
        </div>

        {/* Chart */}
        <ChartContainer config={chartConfig} className="h-48 w-full">
          <LineChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis 
              dataKey="date" 
              fontSize={12} 
              tickLine={false}
              axisLine={false}
              className="fill-muted-foreground"
            />
            <YAxis 
              fontSize={12}
              tickLine={false}
              axisLine={false}
              domain={['auto', 'auto']}
              reversed={lowerIsBetter}
              className="fill-muted-foreground"
            />
            <ChartTooltip 
              content={<ChartTooltipContent />}
              labelFormatter={(value, payload) => {
                if (payload && payload[0]) {
                  return `${payload[0].payload.fullDate} (${payload[0].payload.source})`;
                }
                return value;
              }}
            />
            <Line 
              type="monotone" 
              dataKey="rating" 
              stroke="hsl(var(--primary))" 
              strokeWidth={2}
              dot={{ fill: 'hsl(var(--primary))', strokeWidth: 2 }}
              activeDot={{ r: 6 }}
            />
          </LineChart>
        </ChartContainer>

        <div className="flex flex-col items-center gap-1 mt-2">
          {lowerIsBetter && (
            <p className="text-xs text-muted-foreground">
              {t('ratingHistory.knltbNote', `In ${systemConfig?.name || 'this system'}, a lower rating means better performance`)}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {t('ratingHistory.updateSchedule', 'Ratings are updated every 15th of the month')}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
