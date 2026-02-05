import { supabase } from "@/integrations/supabase/client";

export interface EnrichmentResult {
  location_id: string;
  location_name: string;
  status: "success" | "skipped" | "error";
  error?: string;
  data?: {
    indoor_courts: number;
    outdoor_courts: number;
    description: string;
    logo_url: string | null;
  };
}

export interface LogoResult {
  location_id: string;
  location_name: string;
  status: "success" | "skipped" | "error";
  error?: string;
  logo_url?: string | null;
}

export interface EnrichLocationsOptions {
  location_ids?: string[];
  batch_size?: number;
  offset?: number;
  dry_run?: boolean;
}

export interface EnrichLocationsResponse {
  success: boolean;
  dry_run: boolean;
  batch_size: number;
  offset: number;
  next_offset: number;
  total_processed: number;
  summary: {
    success: number;
    skipped: number;
    errors: number;
  };
  results: EnrichmentResult[];
}

export interface FetchLogosOptions {
  location_ids?: string[];
  batch_size?: number;
  offset?: number;
  dry_run?: boolean;
}

export interface FetchLogosResponse {
  success: boolean;
  dry_run: boolean;
  batch_size: number;
  offset: number;
  next_offset: number;
  total_processed: number;
  summary: {
    success: number;
    no_logo: number;
    errors: number;
  };
  results: LogoResult[];
}

export async function enrichLocations(
  options: EnrichLocationsOptions = {}
): Promise<EnrichLocationsResponse> {
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session) {
    throw new Error("Not authenticated");
  }

  const response = await supabase.functions.invoke("enrich-clubs", {
    body: options,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  if (response.error) {
    throw new Error(response.error.message || "Failed to enrich locations");
  }

  return response.data as EnrichLocationsResponse;
}

export async function fetchLocationLogos(
  options: FetchLogosOptions = {}
): Promise<FetchLogosResponse> {
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session) {
    throw new Error("Not authenticated");
  }

  const response = await supabase.functions.invoke("fetch-location-logos", {
    body: options,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  if (response.error) {
    throw new Error(response.error.message || "Failed to fetch logos");
  }

  return response.data as FetchLogosResponse;
}

export interface AdminStats {
  overview: {
    totalGMV: number;
    platformFees: number;
    avgFeePercent: number;
    totalBookings: number;
    paidBookings: number;
    activeTrainers: number;
    activePlayers: number;
    connectedAccounts: number;
    pendingAccounts: number;
    totalClubs: number;
    verifiedClubs: number;
    subscribedClubs: number;
    trialingClubs: number;
    expiredTrialClubs: number;
  };
  signupTrends: {
    trainersThisMonth: number;
    trainersLastMonth: number;
    trainerTrend: number;
    playersThisMonth: number;
    playersLastMonth: number;
    playerTrend: number;
  };
  trainersByTier: {
    starter: number;
    professional: number;
    academy: number;
  };
  clubStats: {
    total: number;
    verified: number;
    subscribed: number;
    trialing: number;
    expired: number;
  };
  monthlyStats: Array<{
    month: string;
    gmv: number;
    fees: number;
    bookings: number;
  }>;
}

export async function getAdminStats(): Promise<AdminStats> {
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session) {
    throw new Error("Not authenticated");
  }

  const response = await supabase.functions.invoke("get-admin-stats", {
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  if (response.error) {
    throw new Error(response.error.message || "Failed to fetch admin stats");
  }

  return response.data as AdminStats;
}

export interface ScrapeAcademiesParams {
  batch_size?: number;
  page_offset?: number;
  dry_run?: boolean;
  academy_slugs?: string[];
}

export interface ScrapeAcademiesResult {
  success: boolean;
  page: number;
  batch_size: number;
  dry_run: boolean;
  scraped: number;
  created: number;
  skipped: number;
  errors: string[];
  academies: Array<{ name: string; slug: string; status: string }>;
}

export async function scrapeAcademies(
  params: ScrapeAcademiesParams = {}
): Promise<ScrapeAcademiesResult> {
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session) {
    throw new Error("Not authenticated");
  }

  const response = await supabase.functions.invoke("scrape-academies", {
    body: params,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  if (response.error) {
    throw new Error(response.error.message || "Failed to scrape academies");
  }

  return response.data as ScrapeAcademiesResult;
}

export async function isUserAdmin(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin");

  if (error || !data) return false;
  return data.length > 0;
}

export async function bulkCleanupUsers(): Promise<{
  success: boolean;
  message: string;
  deleted?: string[];
  errors?: string[];
}> {
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session) {
    throw new Error("Not authenticated");
  }

  const response = await supabase.functions.invoke("bulk-cleanup-users", {
    body: { confirm: true },
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  if (response.error) {
    throw new Error(response.error.message || "Failed to cleanup users");
  }

  return response.data;
}

// Background logo fetching cron job management
export interface BackgroundLogoJobStatus {
  isEnabled: boolean;
  jobId: number | null;
  pendingCount: number;
  processedCount: number;
  withLogosCount: number;
}

export async function getBackgroundLogoJobStatus(): Promise<BackgroundLogoJobStatus> {
  // Check if cron job exists
  const { data: cronJob } = await supabase
    .from("cron.job" as any)
    .select("jobid")
    .eq("jobname", "fetch-location-logos-background")
    .single();

  // Get location stats
  const { count: pendingCount } = await supabase
    .from("locations")
    .select("*", { count: "exact", head: true })
    .not("website_url", "is", null)
    .is("logo_fetched_at", null);

  const { count: processedCount } = await supabase
    .from("locations")
    .select("*", { count: "exact", head: true })
    .not("website_url", "is", null)
    .not("logo_fetched_at", "is", null);

  const { count: withLogosCount } = await supabase
    .from("locations")
    .select("*", { count: "exact", head: true })
    .not("logo_url", "is", null);

  return {
    isEnabled: !!cronJob,
    jobId: cronJob?.jobid || null,
    pendingCount: pendingCount || 0,
    processedCount: processedCount || 0,
    withLogosCount: withLogosCount || 0,
  };
}

export async function enableBackgroundLogoJob(): Promise<{ success: boolean; jobId?: number }> {
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session) {
    throw new Error("Not authenticated");
  }

  // Check if job already exists
  const { data: existingJob } = await supabase
    .from("cron.job" as any)
    .select("jobid")
    .eq("jobname", "fetch-location-logos-background")
    .single();

  if (existingJob) {
    return { success: true, jobId: existingJob.jobid };
  }

  // Create the cron job via RPC
  const { data, error } = await supabase.rpc("schedule_logo_fetch_job" as any);
  
  if (error) {
    throw new Error(error.message || "Failed to enable background job");
  }

  return { success: true, jobId: data };
}

export async function disableBackgroundLogoJob(): Promise<{ success: boolean }> {
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session) {
    throw new Error("Not authenticated");
  }

  const { error } = await supabase.rpc("unschedule_logo_fetch_job" as any);
  
  if (error) {
    throw new Error(error.message || "Failed to disable background job");
  }

  return { success: true };
}

export async function resetLogoFetchedAt(options: { 
  onlyWithoutLogos?: boolean;
}): Promise<{ count: number }> {
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session) {
    throw new Error("Not authenticated");
  }

  let query = supabase
    .from("locations")
    .update({ logo_fetched_at: null })
    .not("website_url", "is", null)
    .not("logo_fetched_at", "is", null);

  if (options.onlyWithoutLogos) {
    query = query.is("logo_url", null);
  }

  const { data, error } = await query.select("id");
  
  if (error) {
    throw new Error(error.message || "Failed to reset logo_fetched_at");
  }

  return { count: data?.length || 0 };
}
