import { useState, useEffect, useCallback } from 'react';
import { Play, Square, Loader2, Zap, RotateCcw, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabaseClient';

export function EnrichmentControls() {
  const { toast } = useToast();
  const [isRunning, setIsRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [missingCount, setMissingCount] = useState<number | null>(null);
  const [failedCount, setFailedCount] = useState<number | null>(null);

  const checkStatus = useCallback(async () => {
    try {
      const [statusResult, pendingResult, failedResult] = await Promise.all([
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
      ]);

      if (statusResult.data) {
        setIsRunning((statusResult.data as any).is_enabled ?? false);
      }
      setMissingCount(pendingResult.count ?? 0);
      setFailedCount(failedResult.count ?? 0);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 30000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  const startJob = async () => {
    setToggling(true);
    try {
      const { error } = await supabase.rpc('schedule_enrichment_job');
      if (error) throw error;
      setIsRunning(true);
      toast({ title: 'Enrichment started', description: 'Processing 5 locations every 2 minutes' });
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally {
      setToggling(false);
    }
  };

  const stopJob = async () => {
    setToggling(true);
    try {
      const { error } = await supabase.rpc('unschedule_enrichment_job');
      if (error) throw error;
      setIsRunning(false);
      toast({ title: 'Enrichment stopped' });
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally {
      setToggling(false);
    }
  };

  const retryFailed = async () => {
    setRetrying(true);
    try {
      const { error } = await supabase
        .from('locations')
        .update({ enrichment_failed_at: null, enrichment_error_msg: null } as any)
        .not('enrichment_failed_at', 'is', null);
      if (error) throw error;
      toast({ title: 'Failed locations reset', description: 'They will be retried on the next run' });
      await checkStatus();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally {
      setRetrying(false);
    }
  };

  if (loading) return null;

  return (
    <div className="flex items-center gap-2">
      {missingCount !== null && missingCount > 0 && (
        <span className="text-xs text-muted-foreground">{missingCount} pending</span>
      )}
      {failedCount !== null && failedCount > 0 && (
        <span className="text-xs text-destructive flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" />
          {failedCount} failed
        </span>
      )}
      <Badge variant={isRunning ? 'default' : 'outline'} className="gap-1">
        <Zap className="h-3 w-3" />
        {isRunning ? 'Enriching' : 'Stopped'}
      </Badge>
      {failedCount !== null && failedCount > 0 && (
        <Button variant="outline" size="sm" onClick={retryFailed} disabled={retrying}>
          {retrying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-1" />}
          Retry failed
        </Button>
      )}
      {isRunning ? (
        <Button variant="outline" size="sm" onClick={stopJob} disabled={toggling}>
          {toggling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4 mr-1" />}
          Stop
        </Button>
      ) : (
        <Button variant="outline" size="sm" onClick={startJob} disabled={toggling}>
          {toggling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 mr-1" />}
          Enrich
        </Button>
      )}
    </div>
  );
}
