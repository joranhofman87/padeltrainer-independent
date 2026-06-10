import { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid } from 'recharts';
import { TrendingUp, TrendingDown, Minus, Download, Share2, Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabaseClient';
import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { getRatingSystemByCode, RatingSystemConfig } from '@/lib/ratingSystems';
import { toast } from 'sonner';
import { Logo } from '@/components/Logo';
import { MARKETING_DOMAIN } from '@/lib/domains';
import { buildShareCardData, buildShareCardSvg, svgToPngBlob } from '@/lib/ratingShareCard';

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
  playerName?: string;
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
  ratingSystem,
  playerName = '',
}: RatingHistoryChartProps) {
  const { t, i18n } = useTranslation('player');
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

  const lowerIsBetter = systemConfig?.lower_is_better ?? (ratingSystem === 'knltb');

  const getShareableUrl = () => {
    const lang = i18n.language || 'nl';
    return `${MARKETING_DOMAIN}/${lang}/rating/${profileId}`;
  };

  const generatePngBlob = async (): Promise<Blob | null> => {
    const data = buildShareCardData(
      playerName,
      history,
      systemConfig?.name || ratingSystem.toUpperCase(),
      lowerIsBetter,
    );
    if (!data) return null;
    try {
      const svg = buildShareCardSvg(data);
      return await svgToPngBlob(svg);
    } catch (err) {
      logger.error('Failed to generate share card', err instanceof Error ? err : new Error(String(err)));
      return null;
    }
  };

  const handleDownloadPng = async () => {
    const blob = await generatePngBlob();
    if (!blob) {
      toast.error(t('ratingHistory.downloadError', 'Failed to download image'));
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `rating-progress-${format(new Date(), 'yyyy-MM-dd')}.png`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
    toast.success(t('ratingHistory.downloadSuccess', 'Image downloaded'));
  };

  const handleNativeShare = async () => {
    const blob = await generatePngBlob();
    if (!blob) {
      toast.error(t('ratingShare.failedToGenerateImage'));
      return;
    }
    const file = new File([blob], 'rating-progress.png', { type: 'image/png' });
    const shareUrl = getShareableUrl();
    
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({
          title: `${playerName || 'My'} Padel Rating Progress`,
          text: `Check out my padel rating progress on PadelTrainer.ai! ${shareUrl}`,
          files: [file],
        });
      } catch (err) {
        // User cancelled
      }
    } else if (navigator.share) {
      try {
        await navigator.share({
          title: `${playerName || 'My'} Padel Rating Progress`,
          text: `Check out my padel rating progress on PadelTrainer.ai! ${shareUrl}`,
        });
      } catch (err) {
        // User cancelled
      }
    }
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(getShareableUrl());
      setCopied(true);
      toast.success(t('ratingShare.linkCopied'));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t('ratingShare.failedToCopy'));
    }
  };

  const handleShareWhatsApp = () => {
    const url = getShareableUrl();
    const text = `Check out my padel rating progress! ${url}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  };

  const handleShareX = () => {
    const url = getShareableUrl();
    const text = `Check out my padel rating progress on @PadelTrainerAI!`;
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, '_blank');
  };

  // Calculate stats
  const firstRating = history.length > 0 ? history[0].rating : null;
  const latestRating = history.length > 0 ? history[history.length - 1].rating : currentRating;
  const rawDifference = firstRating && latestRating ? Number((firstRating - latestRating).toFixed(2)) : 0;
  const improvement = lowerIsBetter ? rawDifference : -rawDifference;
  const hasImproved = improvement > 0;
  const hasDeclined = improvement < 0;

  const bestRating = history.length > 0
    ? (lowerIsBetter
        ? Math.min(...history.map(e => e.rating))
        : Math.max(...history.map(e => e.rating)))
    : null;

  const formatRating = (val: number | null) => {
    if (val === null) return '—';
    return val.toFixed(1);
  };

  const chartData = history.map(entry => ({
    date: format(new Date(entry.scraped_at), "MMM ''yy"),
    fullDate: format(new Date(entry.scraped_at), 'MMM d, yyyy'),
    rating: entry.rating,
    source: 'Manual',
  }));

  const canNativeShare = typeof navigator !== 'undefined' && !!navigator.share;

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
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" aria-label={t('ratingHistory.downloadImage', 'Download')} onClick={handleDownloadPng}>
              <Download className="h-4 w-4" />
              <span className="hidden sm:inline">{t('ratingHistory.downloadImage', 'Download')}</span>
            </Button>
            {canNativeShare ? (
              <Button variant="outline" size="sm" className="gap-1.5" aria-label={t('ratingHistory.share', 'Share')} onClick={handleNativeShare}>
                <Share2 className="h-4 w-4" />
                <span className="hidden sm:inline">{t('ratingHistory.share', 'Share')}</span>
              </Button>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1.5" aria-label={t('ratingHistory.share', 'Share')}>
                    <Share2 className="h-4 w-4" />
                    <span className="hidden sm:inline">{t('ratingHistory.share', 'Share')}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={handleCopyLink}>
                    {copied ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
                    {copied ? 'Copied!' : 'Copy link'}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleShareWhatsApp}>
                    WhatsApp
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleShareX}>
                    X / Twitter
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
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
            <p className="text-lg font-bold font-mono">
              {formatRating(latestRating)}
              {improvement !== 0 && (
                <span className={`ml-1.5 text-xs font-semibold ${hasImproved ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                  {improvement > 0 ? '+' : ''}{improvement.toFixed(1)}
                </span>
              )}
            </p>
          </div>
          <div className="text-center p-3 bg-primary/10 rounded-lg">
            <p className="text-xs text-muted-foreground">{t('ratingHistory.best', 'Best')}</p>
            <p className="text-lg font-bold font-mono text-primary">{formatRating(bestRating)}</p>
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

        {/* Logo watermark for exported image */}
        <div className="flex justify-end mt-3 opacity-60">
          <Logo className="h-5" />
        </div>
      </CardContent>
    </Card>
  );
}
