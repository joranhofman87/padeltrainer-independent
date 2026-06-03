import { supabase } from "@/lib/supabaseClient";
import { logger } from "@/lib/logger";

export const ACADEMY_CYCLES_TAB_PATH = "/app/academy/calendar";

export function buildAcademyCycleDetailPath(cyclusId: string): string {
  return `/app/academy/cycles/${encodeURIComponent(cyclusId)}`;
}

export function buildAcademyCalendarCyclesFallbackPath(cyclusId: string): string {
  const params = new URLSearchParams({ tab: "list", cyclusId });
  return `${ACADEMY_CYCLES_TAB_PATH}?${params.toString()}`;
}

export type CyclesRowLookupResult = "exists" | "missing" | "error";

/**
 * Lightweight check: does public.cycles have a row with this id?
 * Bulk recurring slots use cyclus_id on availability_slots only — no cycles row.
 */
export async function lookupCyclesRowById(
  cyclusId: string,
): Promise<CyclesRowLookupResult> {
  const { data, error } = await supabase
    .from("cycles")
    .select("id")
    .eq("id", cyclusId)
    .maybeSingle();

  if (error) {
    logger.warn("cycles row lookup failed, using calendar fallback", {
      component: "cyclusPricingRoute",
      cyclusId,
      code: error.code,
      message: error.message,
    });
    return "error";
  }

  return data?.id ? "exists" : "missing";
}

/**
 * Academy "Edit cycle pricing" target: real cycle detail or calendar cycles tab.
 */
export async function resolveAcademyCyclusPricingRoute(
  cyclusId: string,
): Promise<string> {
  const lookup = await lookupCyclesRowById(cyclusId);
  if (lookup === "exists") {
    return buildAcademyCycleDetailPath(cyclusId);
  }
  return buildAcademyCalendarCyclesFallbackPath(cyclusId);
}
