import { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid } from 'recharts';
import { TrendingUp, TrendingDown, Minus, Download, Share2, Link2, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabaseClient';
import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { getRatingSystemByCode, RatingSystemConfig } from '@/lib/ratingSystems';
import { toPng } from 'html-to-image';
import { toast } from 'sonner';

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
  const [copied, setCopied] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

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
      const { data, error } = await supabase
        .from('player_rating_history')
        .select('*')
        .eq('profile_id', profileId)
        .eq('rating_system', ratingSystem)
        .order('scraped_at', { ascending: true });

      if (error) {
        logger.error('Error fetching rating history', error instanceof Error ? error : new Error(String(error)), { component: 'RatingHistoryChart' });
      } else {
        setHistory(data || []);
      }
    } catch (err) {
      logger.error('Failed to fetch history', err instanceof Error ? err : new Error(String(err)), { component: 'RatingHistoryChart' });
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadPng = async () => {
    if (!cardRef.current) return;
    try {
      const dataUrl = await toPng(cardRef.current, {
        backgroundColor: '#ffffff',
        pixelRatio: 2,
      });
      const link = document.createElement('a');
      link.download = `rating-progress-${format(new Date(), 'yyyy-MM-dd')}.png`;
      link.href = dataUrl;
      link.click();
      toast.success(t('ratingHistory.downloadSuccess', 'Image downloaded'));
    } catch (err) {
      logger.error('Failed to export chart', err instanceof Error ? err : new Error(String(err)));
      toast.error(t('ratingHistory.downloadError', 'Failed to download image'));
    }
  };

  const handleShare = async () => {
    const shareUrl = window.location.origin;
    const shareData = {
      title: t('ratingHistory.shareTitle', 'My Padel Rating Progress'),
      text: t('ratingHistory.shareText', 'Check out my padel rating progress on PadelTrainer.ai!'),
      url: shareUrl,
    };

    if (navigator.share) {
      try {
        await navigator.share(shareData);
      } catch {
        // User cancelled — ignore
      }
    } else {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      toast.success(t('ratingHistory.linkCopied', 'Link copied to clipboard'));
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Calculate improvement based on rating system direction
  const firstRating = history.length > 0 ? history[0].rating : null;
  const latestRating = history.length > 0 ? history[history.length - 1].rating : currentRating;
  const rawDifference = firstRating && latestRating ? Number((firstRating - latestRating).toFixed(2)) : 0;
  
  const lowerIsBetter = systemConfig?.lower_is_better ?? (ratingSystem === 'knltb');
  const improvement = lowerIsBetter ? rawDifference : -rawDifference;
  const hasImproved = improvement > 0;
  const hasDeclined = improvement < 0;

  const formatRating = (val: number | null) => {
    if (val === null) return '—';
    return val.toFixed(1);
  };

  // Format data for chart
  const chartData = history.map(entry => ({
    date: format(new Date(entry.scraped_at), "MMM ''yy"),
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
    <Card ref={cardRef}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
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
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5">
                <Share2 className="h-4 w-4" />
                <span className="hidden sm:inline">{t('ratingHistory.share', 'Share')}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleDownloadPng} className="gap-2">
                <Download className="h-4 w-4" />
                {t('ratingHistory.downloadImage', 'Download as image')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleShare} className="gap-2">
                {copied ? <Check className="h-4 w-4" /> : <Link2 className="h-4 w-4" />}
                {t('ratingHistory.shareProgress', 'Share progress')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>
      <CardContent>
        {/* Stats row */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="text-center p-3 bg-muted/50 rounded-lg">
            <p className="text-xs text-muted-foreground">{t('ratingHistory.started', 'Started')}</p>
            <p className="text-lg font-bold font-mono">{formatRating(firstRating)}</p>
          </div>
          <div className="text-center p-3 bg-muted/50 rounded-lg">
            <p className="text-xs text-muted-foreground">{t('ratingHistory.current', 'Current')}</p>
            <p className="text-lg font-bold font-mono">{formatRating(latestRating)}</p>
          </div>
          <div className={`text-center p-3 rounded-lg ${
            hasImproved ? 'bg-green-100 dark:bg-green-900/30' : 
            hasDeclined ? 'bg-red-100 dark:bg-red-900/30' : 
            'bg-muted/50'
          }`}>
            <p className="text-xs text-muted-foreground">{t('ratingHistory.improvement', 'Improvement')}</p>
            <p className={`text-lg font-bold font-mono ${
              hasImproved ? 'text-green-600 dark:text-green-400' : 
              hasDeclined ? 'text-red-600 dark:text-red-400' : ''
            }`}>
              {improvement !== 0 ? (improvement > 0 ? '+' : '') + improvement.toFixed(1) : '—'}
            </p>
          </div>
        </div>

        {/* Chart */}
        <ChartContainer config={chartConfig} className="h-64 w-full">
          <AreaChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 30 }}>
            <defs>
              <linearGradient id="ratingGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
            <XAxis 
              dataKey="date" 
              fontSize={11} 
              tickLine={false}
              axisLine={false}
              className="fill-muted-foreground"
              interval="preserveStartEnd"
              angle={-45}
              textAnchor="end"
              height={50}
            />
            <YAxis 
              fontSize={11}
              tickLine={false}
              axisLine={false}
              domain={['auto', 'auto']}
              reversed={lowerIsBetter}
              className="fill-muted-foreground"
              width={35}
              tickFormatter={(val) => val.toFixed(1)}
            />
            <ChartTooltip 
              content={<ChartTooltipContent />}
              labelFormatter={(value, payload) => {
                if (payload && payload[0]) {
                  return `${payload[0].payload.fullDate}`;
                }
                return value;
              }}
            />
            <Area 
              type="monotone" 
              dataKey="rating" 
              stroke="hsl(var(--primary))" 
              strokeWidth={2.5}
              fill="url(#ratingGradient)"
              dot={false}
              activeDot={{ r: 5, fill: 'hsl(var(--primary))', strokeWidth: 2, stroke: 'hsl(var(--background))' }}
            />
          </AreaChart>
        </ChartContainer>

        <div className="flex flex-col items-center gap-1 mt-3">
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
