import { supabase } from '@/lib/supabaseClient';
import { MARKETING_DOMAIN } from '@/lib/domains';

/**
 * Generic branded short links (padeltrainer.ai/s/<code>). The primitive is entity-agnostic — any
 * surface can mint a short link for a site-root-relative path and get one code per destination.
 * Resolution (the /s/<code> → 301 hot path) lives in the Cloudflare Worker; these helpers are the
 * mint + admin-read seams. See supabase/migrations/20260825100000_short_links.sql.
 */

/** Absolute short-link URL for a code. */
export function getShortUrl(code: string): string {
  return `${MARKETING_DOMAIN}/s/${code}`;
}

/** The canonical short-link TARGET for a registration form — slug-less so it's rename-proof, and the
 *  path render-page already serves the per-form social preview for. */
export function registrationShortTargetPath(registrationId: string): string {
  return `/nl/register/${registrationId}`;
}

/**
 * Mint-or-fetch a branded short link for any site-root-relative path. Idempotent (one code per
 * destination). Authenticated-only. Registrations are minted eagerly by a DB trigger, so most callers
 * read the code via {@link getShortCodesByTarget}; use this for lazy/other-entity minting.
 */
export async function getOrCreateShortLink(
  targetPath: string,
  targetType: string,
  opts?: { targetId?: string | null; params?: Record<string, unknown>; permanent?: boolean },
): Promise<string> {
  const { data, error } = await supabase.rpc('get_or_create_short_link' as never, {
    _target_path: targetPath,
    _target_type: targetType,
    _target_id: opts?.targetId ?? null,
    _target_params: (opts?.params ?? {}) as never,
    _permanent: opts?.permanent ?? true,
  } as never);
  if (error) throw error;
  return getShortUrl(data as unknown as string);
}

/**
 * Batch reverse lookup: target id → short code, for admin listing joins. Resilient — returns an empty
 * map on any error so a listing still renders (callers fall back to the long URL). RLS blocks direct
 * table reads, so this goes through the get_short_codes SECURITY DEFINER reader.
 */
export async function getShortCodesByTarget(
  targetType: string,
  targetIds: string[],
): Promise<Map<string, string>> {
  if (targetIds.length === 0) return new Map();
  try {
    const { data, error } = await supabase.rpc('get_short_codes' as never, {
      _target_type: targetType,
      _target_ids: targetIds,
    } as never);
    if (error) throw error;
    const rows = (data ?? []) as unknown as { target_id: string; code: string }[];
    return new Map(rows.map((r) => [r.target_id, r.code]));
  } catch {
    return new Map();
  }
}
