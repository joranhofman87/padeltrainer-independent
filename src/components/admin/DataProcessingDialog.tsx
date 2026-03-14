import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Loader2, Zap, Image, RotateCcw, AlertTriangle, Clock, Play, Square,
  CheckCircle2, XCircle, AlertCircle, RefreshCw,
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabaseClient';
import {
  fetchLocationLogos, type LogoResult,
  getBackgroundLogoJobStatus, enableBackgroundLogoJob, disableBackgroundLogoJob,
  resetLogoFetchedAt, type BackgroundLogoJobStatus,
} from '@/lib/admin';
import { logger } from '@/lib/logger';

interface DataProcessingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function DataProcessingDialog({ open, onOpenChange, onSuccess }: DataProcessingDialogProps) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);

  // Enrichment state
  const [enrichmentRunning, setEnrichmentRunning] = useState(false);
  const [enrichmentPending, setEnrichmentPending] = useState(0);
  const [enrichmentFailed, setEnrichmentFailed] = useState(0);
  const [togglingEnrichment, setTogglingEnrichment] = useState(false);
  const [retryingEnrichment, setRetryingEnrichment] = useState(false);

  // Logo state
  const [logoStatus, setLogoStatus] = useState<BackgroundLogoJobStatus | null>(null);
  const [togglingLogos, setTogglingLogos] = useState(false);
  const [resettingLogos, setResettingLogos] = useState(false);

  // Manual scraping state
  const [manualLocations, setManualLocations] = useState<{ id: string; name: string }[]>([]);
  const [batchSize, setBatchSize] = useState('10');
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentBatch, setCurrentBatch] = useState(0);
  const [results, setResults] = useState<LogoResult[]>([]);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const shouldStopRef = useRef(false);

  const fetchStatus = useCallback(async () => {
    try {
      const [enrichStatus, pendingResult, failedResult, logoJobStatus] = await Promise.all([
        supabase.rpc('check_enrichment_job_status'),
        supabase
          .from('locations')
          .select('id', { count: 'exact', head: true })
          .not('website_url', 'is', null)
          .is('description', null)
          .is('enrichment_failed_at', null)
          .eq('is_active', true),
        supabase
          .from('locations')
          .select('id', { count: 'exact', head: true })
          .not('enrichment_failed_at', 'is', null),
        getBackgroundLogoJobStatus(),
      ]);

      if (enrichStatus.data) {
        setEnrichmentRunning((enrichStatus.data as any).is_enabled ?? false);
      }
      setEnrichmentPending(pendingResult.count ?? 0);
      setEnrichmentFailed(failedResult.count ?? 0);
      setLogoStatus(logoJobStatus);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setResults([]);
    setProgress(0);
    fetchStatus();
    fetchManualLocations();
    const interval = setInterval(fetchStatus, 30000);
    return () => clearInterval(interval);
  }, [open, fetchStatus]);

  // Timer for manual scraping
  useEffect(() => {
    if (!processing) { setElapsedSeconds(0); return; }
    const interval = setInterval(() => setElapsedSeconds(s => s + 1), 1000);
    return () => clearInterval(interval);
  }, [processing]);

  async function fetchManualLocations() {
    const { data } = await supabase
      .from('locations')
      .select('id, name')
      .not('website_url', 'is', null)
      .is('logo_url', null)
      .eq('is_active', true)
      .order('name');
    setManualLocations(data || []);
  }

  // Enrichment controls
  const toggleEnrichment = async () => {
    setTogglingEnrichment(true);
    try {
      if (enrichmentRunning) {
        const { error } = await supabase.rpc('unschedule_enrichment_job');
        if (error) throw error;
        setEnrichmentRunning(false);
        toast({ title: 'Enrichment stopped' });
      } else {
        const { error } = await supabase.rpc('schedule_enrichment_job');
        if (error) throw error;
        setEnrichmentRunning(true);
        toast({ title: 'Enrichment started', description: '5 locations every 2 minutes' });
      }
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally {
      setTogglingEnrichment(false);
    }
  };

  const retryEnrichmentFailed = async () => {
    setRetryingEnrichment(true);
    try {
      const { error } = await supabase
        .from('locations')
        .update({ enrichment_failed_at: null, enrichment_error_msg: null } as any)
        .not('enrichment_failed_at', 'is', null);
      if (error) throw error;
      toast({ title: 'Failed locations reset' });
      await fetchStatus();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally {
      setRetryingEnrichment(false);
    }
  };

  // Logo controls
  const toggleLogos = async (enabled: boolean) => {
    setTogglingLogos(true);
    try {
      if (enabled) {
        await enableBackgroundLogoJob();
        toast({ title: 'Logo fetching started', description: '10 locations every 15 minutes' });
      } else {
        await disableBackgroundLogoJob();
        toast({ title: 'Logo fetching stopped' });
      }
      await fetchStatus();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally {
      setTogglingLogos(false);
    }
  };

  const retryLogosFailed = async () => {
    setResettingLogos(true);
    try {
      const { count } = await resetLogoFetchedAt({ onlyWithoutLogos: true });
      toast({ title: 'Reset complete', description: `${count} locations will be retried` });
      await fetchStatus();
      await fetchManualLocations();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally {
      setResettingLogos(false);
    }
  };

  // Manual scraping
  async function startManualScraping() {
    if (manualLocations.length === 0) return;
    setProcessing(true);
    setResults([]);
    setProgress(0);
    shouldStopRef.current = false;

    const batch = parseInt(batchSize);
    const totalBatches = Math.ceil(manualLocations.length / batch);
    let allResults: LogoResult[] = [];
    let processedCount = 0;

    for (let i = 0; i < totalBatches && !shouldStopRef.current; i++) {
      setCurrentBatch(i + 1);
      const batchIds = manualLocations.slice(i * batch, (i + 1) * batch).map(l => l.id);
      try {
        const response = await fetchLocationLogos({ location_ids: batchIds, batch_size: batch, dry_run: false });
        allResults = [...allResults, ...response.results];
        setResults([...allResults]);
        processedCount += batchIds.length;
        setProgress((processedCount / manualLocations.length) * 100);
        if (i < totalBatches - 1) await new Promise(r => setTimeout(r, 1000));
      } catch (error) {
        logger.error('Manual batch error', error instanceof Error ? error : new Error(String(error)), { component: 'DataProcessingDialog' });
        toast({ title: 'Batch Error', description: `Error processing batch ${i + 1}`, variant: 'destructive' });
      }
    }

    setProcessing(false);
    const successCount = allResults.filter(r => r.status === 'success' && r.logo_url).length;
    toast({ title: 'Scraping complete', description: `Found ${successCount} logos out of ${allResults.length} processed` });
    if (successCount > 0) onSuccess?.();
  }

  const activeJobCount = (enrichmentRunning ? 1 : 0) + (logoStatus?.isEnabled ? 1 : 0);

  const successResults = results.filter(r => r.status === 'success' && r.logo_url);
  const failedResults = results.filter(r => r.status === 'error' || (r.status === 'success' && !r.logo_url));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5" />
            Data Processing
          </DialogTitle>
          <DialogDescription>
            Manage automated enrichment and logo fetching jobs.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : (
          <ScrollArea className="flex-1">
            <div className="space-y-6 pr-4">
              {/* Section 1: Enrichment */}
              <div className="rounded-lg border p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Zap className="h-4 w-4 text-muted-foreground" />
                    <Label className="font-medium text-base">Enrichment</Label>
                    <Badge variant={enrichmentRunning ? 'default' : 'outline'} className="text-xs">
                      {enrichmentRunning ? 'Running' : 'Stopped'}
                    </Badge>
                  </div>
                  <Switch
                    checked={enrichmentRunning}
                    onCheckedChange={toggleEnrichment}
                    disabled={togglingEnrichment}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Fills descriptions, contact info, and hours. Processes 5 locations every 2 minutes.
                </p>
                <div className="flex items-center gap-4 text-sm">
                  {enrichmentPending > 0 && (
                    <span className="text-muted-foreground">{enrichmentPending} pending</span>
                  )}
                  {enrichmentFailed > 0 && (
                    <span className="text-destructive flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" />
                      {enrichmentFailed} failed
                    </span>
                  )}
                </div>
                {enrichmentFailed > 0 && (
                  <Button variant="outline" size="sm" onClick={retryEnrichmentFailed} disabled={retryingEnrichment} className="w-full">
                    {retryingEnrichment ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RotateCcw className="h-4 w-4 mr-2" />}
                    Retry {enrichmentFailed} failed
                  </Button>
                )}
              </div>

              {/* Section 2: Logo Fetching */}
              <div className="rounded-lg border p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Image className="h-4 w-4 text-muted-foreground" />
                    <Label className="font-medium text-base">Logo Fetching</Label>
                    <Badge variant={logoStatus?.isEnabled ? 'default' : 'outline'} className="text-xs">
                      {logoStatus?.isEnabled ? 'Running' : 'Stopped'}
                    </Badge>
                  </div>
                  <Switch
                    checked={logoStatus?.isEnabled ?? false}
                    onCheckedChange={toggleLogos}
                    disabled={togglingLogos}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Extracts logos from websites using AI. Processes 10 locations every 15 minutes.
                </p>
                {logoStatus && (
                  <div className="grid grid-cols-3 gap-3">
                    <div className="text-center">
                      <div className="text-lg font-semibold">{logoStatus.pendingCount}</div>
                      <div className="text-xs text-muted-foreground">Pending</div>
                    </div>
                    <div className="text-center">
                      <div className="text-lg font-semibold">{logoStatus.processedCount}</div>
                      <div className="text-xs text-muted-foreground">Processed</div>
                    </div>
                    <div className="text-center">
                      <div className="text-lg font-semibold text-green-600">{logoStatus.withLogosCount}</div>
                      <div className="text-xs text-muted-foreground">Have Logos</div>
                    </div>
                  </div>
                )}
                {logoStatus && logoStatus.processedCount > logoStatus.withLogosCount && (
                  <Button variant="outline" size="sm" onClick={retryLogosFailed} disabled={resettingLogos} className="w-full">
                    {resettingLogos ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                    Retry {logoStatus.processedCount - logoStatus.withLogosCount} failed
                  </Button>
                )}
              </div>

              <Separator />

              {/* Section 3: Manual Logo Scraping */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium flex items-center gap-2">
                  <Play className="h-4 w-4" />
                  Manual Logo Scraping
                </h3>
                <p className="text-xs text-muted-foreground">
                  {manualLocations.length} locations without logos ready for immediate processing.
                </p>

                {!processing && results.length === 0 && (
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">Batch:</span>
                      <Select value={batchSize} onValueChange={setBatchSize}>
                        <SelectTrigger className="w-[80px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="5">5</SelectItem>
                          <SelectItem value="10">10</SelectItem>
                          <SelectItem value="25">25</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <Button onClick={startManualScraping} disabled={manualLocations.length === 0} size="sm">
                      Start Scraping
                    </Button>
                  </div>
                )}

                {processing && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Batch {currentBatch}...
                        <span className="text-muted-foreground">
                          ({Math.floor(elapsedSeconds / 60)}:{String(elapsedSeconds % 60).padStart(2, '0')})
                        </span>
                      </span>
                      <span>{Math.round(progress)}%</span>
                    </div>
                    <Progress value={progress} />
                    <Button variant="outline" size="sm" onClick={() => { shouldStopRef.current = true; setProcessing(false); }}>
                      <Square className="h-4 w-4 mr-1" /> Stop
                    </Button>
                  </div>
                )}

                {results.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-4 text-sm">
                      <span className="flex items-center gap-1 text-green-600">
                        <CheckCircle2 className="h-4 w-4" /> {successResults.length} found
                      </span>
                      <span className="flex items-center gap-1 text-destructive">
                        <XCircle className="h-4 w-4" /> {failedResults.length} failed
                      </span>
                    </div>
                    <div className="border rounded-md max-h-48 overflow-auto">
                      <div className="p-2 space-y-1">
                        {results.map((result, idx) => (
                          <div key={idx} className="flex items-center gap-2 text-sm py-1 px-2 rounded hover:bg-muted/50">
                            {result.status === 'success' && result.logo_url ? (
                              <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                            ) : (
                              <XCircle className="h-4 w-4 text-destructive shrink-0" />
                            )}
                            <span className="truncate flex-1">{result.location_name}</span>
                            {result.logo_url && (
                              <img src={result.logo_url} alt="" className="h-6 w-6 object-contain rounded" />
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                    {!processing && (
                      <Button size="sm" variant="outline" onClick={() => { setResults([]); fetchManualLocations(); }}>
                        Scrape More
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Compact inline summary for the header bar */
export function DataProcessingBadge({ onClick }: { onClick: () => void }) {
  const [enrichmentRunning, setEnrichmentRunning] = useState(false);
  const [logosRunning, setLogosRunning] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function check() {
      try {
        const [eStatus, lStatus] = await Promise.all([
          supabase.rpc('check_enrichment_job_status'),
          getBackgroundLogoJobStatus(),
        ]);
        if (eStatus.data) setEnrichmentRunning((eStatus.data as any).is_enabled ?? false);
        setLogosRunning(lStatus.isEnabled);
      } catch { /* ignore */ } finally {
        setLoading(false);
      }
    }
    check();
    const interval = setInterval(check, 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading) return null;

  const activeCount = (enrichmentRunning ? 1 : 0) + (logosRunning ? 1 : 0);

  return (
    <Button variant="outline" size="sm" onClick={onClick} className="gap-1.5">
      <Zap className="h-4 w-4" />
      Processing
      <Badge variant={activeCount > 0 ? 'default' : 'outline'} className="ml-1 text-xs">
        {activeCount > 0 ? `${activeCount} active` : 'idle'}
      </Badge>
    </Button>
  );
}
