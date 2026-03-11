import { useState, useEffect, useRef } from "react";
import { logger } from "@/lib/logger";
import { Loader2, Image, AlertCircle, CheckCircle2, XCircle, Play, Square, RefreshCw, Clock } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { 
  fetchLocationLogos, 
  type LogoResult,
  getBackgroundLogoJobStatus,
  enableBackgroundLogoJob,
  disableBackgroundLogoJob,
  resetLogoFetchedAt,
  type BackgroundLogoJobStatus,
} from "@/lib/admin";
import { supabase } from "@/lib/supabaseClient";

interface ScrapeLogosDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

interface LocationWithoutLogo {
  id: string;
  name: string;
  website_url: string;
}

export function ScrapeLogosDialog({
  open,
  onOpenChange,
  onSuccess,
}: ScrapeLogosDialogProps) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [locationsWithoutLogos, setLocationsWithoutLogos] = useState<LocationWithoutLogo[]>([]);
  const [batchSize, setBatchSize] = useState<string>("5");
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<LogoResult[]>([]);
  const [currentBatch, setCurrentBatch] = useState(0);
  const shouldStopRef = useRef(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [backgroundStatus, setBackgroundStatus] = useState<BackgroundLogoJobStatus | null>(null);
  const [togglingBackground, setTogglingBackground] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Timer for elapsed time during processing
  useEffect(() => {
    if (!processing) {
      setElapsedSeconds(0);
      return;
    }
    const interval = setInterval(() => {
      setElapsedSeconds((s) => s + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [processing]);

  useEffect(() => {
    if (open) {
      fetchLocationsWithoutLogos();
      fetchBackgroundStatus();
      setResults([]);
      setProgress(0);
      setCurrentBatch(0);
      shouldStopRef.current = false;
    }
  }, [open]);

  async function fetchBackgroundStatus() {
    try {
      const status = await getBackgroundLogoJobStatus();
      setBackgroundStatus(status);
    } catch (error) {
      logger.error("Error fetching background status", error instanceof Error ? error : new Error(String(error)), { component: 'ScrapeLogosDialog' });
    }
  }

  async function fetchLocationsWithoutLogos() {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("locations")
        .select("id, name, website_url")
        .not("website_url", "is", null)
        .is("logo_url", null)
        .eq("is_active", true)
        .order("name");

      if (error) throw error;
      setLocationsWithoutLogos(data || []);
    } catch (error) {
      console.error("Error fetching locations:", error);
      toast({
        title: "Error",
        description: "Failed to fetch locations",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleBackground(enabled: boolean) {
    setTogglingBackground(true);
    try {
      if (enabled) {
        await enableBackgroundLogoJob();
        toast({
          title: "Background Fetch Enabled",
          description: "Logos will be fetched automatically every 15 minutes",
        });
      } else {
        await disableBackgroundLogoJob();
        toast({
          title: "Background Fetch Disabled",
          description: "Automatic logo fetching has been stopped",
        });
      }
      await fetchBackgroundStatus();
    } catch (error) {
      console.error("Error toggling background job:", error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to toggle background job",
        variant: "destructive",
      });
    } finally {
      setTogglingBackground(false);
    }
  }

  async function handleRetryFailed() {
    setResetting(true);
    try {
      const { count } = await resetLogoFetchedAt({ onlyWithoutLogos: true });
      toast({
        title: "Reset Complete",
        description: `${count} locations will be retried on the next background run`,
      });
      await fetchBackgroundStatus();
      await fetchLocationsWithoutLogos();
    } catch (error) {
      console.error("Error resetting:", error);
      toast({
        title: "Error",
        description: "Failed to reset locations for retry",
        variant: "destructive",
      });
    } finally {
      setResetting(false);
    }
  }

  async function startScraping() {
    if (locationsWithoutLogos.length === 0) return;

    setProcessing(true);
    setResults([]);
    setProgress(0);
    shouldStopRef.current = false;

    const batch = parseInt(batchSize);
    const totalBatches = Math.ceil(locationsWithoutLogos.length / batch);
    let allResults: LogoResult[] = [];
    let processedCount = 0;

    for (let i = 0; i < totalBatches && !shouldStopRef.current; i++) {
      setCurrentBatch(i + 1);
      const startIdx = i * batch;
      const batchLocationIds = locationsWithoutLogos
        .slice(startIdx, startIdx + batch)
        .map((l) => l.id);

      try {
        const response = await fetchLocationLogos({
          location_ids: batchLocationIds,
          batch_size: batch,
          dry_run: false,
        });

        allResults = [...allResults, ...response.results];
        setResults([...allResults]);

        processedCount += batchLocationIds.length;
        setProgress((processedCount / locationsWithoutLogos.length) * 100);

        // Small delay between batches to avoid rate limiting
        if (i < totalBatches - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (error) {
        console.error("Batch error:", error);
        toast({
          title: "Batch Error",
          description: `Error processing batch ${i + 1}`,
          variant: "destructive",
        });
      }
    }

    setProcessing(false);
    
    const successCount = allResults.filter((r) => r.status === "success" && r.logo_url).length;
    toast({
      title: "Scraping Complete",
      description: `Found ${successCount} logos out of ${allResults.length} locations processed`,
    });

    if (successCount > 0) {
      onSuccess?.();
    }
  }

  function stopScraping() {
    shouldStopRef.current = true;
    setProcessing(false);
  }

  const successResults = results.filter((r) => r.status === "success" && r.logo_url);
  const failedResults = results.filter((r) => r.status === "error" || (r.status === "success" && !r.logo_url));
  const skippedResults = results.filter((r) => r.status === "skipped");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Image className="h-5 w-5" />
            Fetch Location Logos
          </DialogTitle>
          <DialogDescription>
            Automatically extract logos from location websites using AI-powered scraping.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : (
          <div className="space-y-4 flex-1 overflow-hidden flex flex-col">
            {/* Background Mode Controls */}
            {backgroundStatus && (
              <div className="bg-muted/50 rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    <Label htmlFor="background-mode" className="font-medium">
                      Background Mode
                    </Label>
                  </div>
                  <Switch
                    id="background-mode"
                    checked={backgroundStatus.isEnabled}
                    onCheckedChange={handleToggleBackground}
                    disabled={togglingBackground}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {backgroundStatus.isEnabled
                    ? "Running every 15 minutes, processing 10 locations per batch"
                    : "Enable to automatically fetch logos in the background"}
                </p>
                
                {/* Stats */}
                <div className="grid grid-cols-3 gap-3 pt-2">
                  <div className="text-center">
                    <div className="text-lg font-semibold">{backgroundStatus.pendingCount}</div>
                    <div className="text-xs text-muted-foreground">Pending</div>
                  </div>
                  <div className="text-center">
                    <div className="text-lg font-semibold">{backgroundStatus.processedCount}</div>
                    <div className="text-xs text-muted-foreground">Processed</div>
                  </div>
                  <div className="text-center">
                    <div className="text-lg font-semibold text-green-600">{backgroundStatus.withLogosCount}</div>
                    <div className="text-xs text-muted-foreground">Have Logos</div>
                  </div>
                </div>

                {/* Retry Failed */}
                {backgroundStatus.processedCount > backgroundStatus.withLogosCount && (
                  <div className="pt-2 border-t">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRetryFailed}
                      disabled={resetting}
                      className="w-full"
                    >
                      {resetting ? (
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      ) : (
                        <RefreshCw className="h-4 w-4 mr-2" />
                      )}
                      Retry {backgroundStatus.processedCount - backgroundStatus.withLogosCount} Failed Locations
                    </Button>
                  </div>
                )}
              </div>
            )}

            <Separator />

            {/* Summary */}
            <div className="bg-muted/50 rounded-lg p-4">
              <div className="flex items-center gap-2 text-lg font-medium">
                <AlertCircle className="h-5 w-5 text-amber-500" />
                {locationsWithoutLogos.length} locations ready for manual scraping
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Use manual mode for immediate processing, or enable background mode above.
              </p>
            </div>

            {/* Controls */}
            {!processing && results.length === 0 && (
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Batch size:</span>
                  <Select value={batchSize} onValueChange={setBatchSize}>
                    <SelectTrigger className="w-[100px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="5">5</SelectItem>
                      <SelectItem value="10">10</SelectItem>
                      <SelectItem value="25">25</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  onClick={startScraping}
                  disabled={locationsWithoutLogos.length === 0}
                >
                  Start Scraping
                </Button>
              </div>
            )}

            {/* Progress */}
            {processing && (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Processing batch {currentBatch}...
                    <span className="text-muted-foreground">
                      (Elapsed: {Math.floor(elapsedSeconds / 60)}:{String(elapsedSeconds % 60).padStart(2, '0')})
                    </span>
                  </span>
                  <span>{Math.round(progress)}%</span>
                </div>
                <Progress value={progress} />
                <p className="text-xs text-muted-foreground">
                  Each location takes 3-5 seconds to process. A batch of {batchSize} takes about {Math.ceil(parseInt(batchSize) * 5 / 60)} minute(s).
                </p>
                <Button variant="outline" size="sm" onClick={stopScraping}>
                  Stop
                </Button>
              </div>
            )}

            {/* Results */}
            {results.length > 0 && (
              <div className="flex-1 overflow-hidden flex flex-col">
                <div className="flex items-center gap-4 text-sm mb-2">
                  <span className="flex items-center gap-1 text-green-600">
                    <CheckCircle2 className="h-4 w-4" />
                    {successResults.length} logos found
                  </span>
                  <span className="flex items-center gap-1 text-red-600">
                    <XCircle className="h-4 w-4" />
                    {failedResults.length} failed
                  </span>
                  {skippedResults.length > 0 && (
                    <span className="text-muted-foreground">
                      {skippedResults.length} skipped
                    </span>
                  )}
                </div>

                <ScrollArea className="flex-1 border rounded-md">
                  <div className="p-2 space-y-1">
                    {results.map((result, idx) => (
                      <div
                        key={idx}
                        className="flex items-center gap-2 text-sm py-1 px-2 rounded hover:bg-muted/50"
                      >
                        {result.status === "success" && result.logo_url ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                        ) : result.status === "skipped" ? (
                          <AlertCircle className="h-4 w-4 text-amber-500 shrink-0" />
                        ) : (
                          <XCircle className="h-4 w-4 text-red-500 shrink-0" />
                        )}
                        <span className="truncate flex-1">{result.location_name}</span>
                        {result.error && (
                          <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                            {result.error}
                          </span>
                        )}
                        {result.logo_url && (
                          <img
                            src={result.logo_url}
                            alt=""
                            className="h-6 w-6 object-contain rounded"
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}

            {/* Done state */}
            {!processing && results.length > 0 && (
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
                <Button
                  onClick={() => {
                    setResults([]);
                    fetchLocationsWithoutLogos();
                  }}
                >
                  Scrape More
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
