/**
 * Academy deletion — the client half of the audited transactional flow.
 *
 * The browser has no route to the database functions: they are granted to `service_role` alone, and
 * the only caller is the authenticated `admin-academy-deletion` edge function. So everything here
 * goes through that one function, and the eight client-side deletes this replaces are gone.
 *
 * The rules this module exists to keep honest:
 *   * a destructive confirmation is never offered against a blocked preview;
 *   * confirmation sends ONLY the server-issued digest and version — never counts, which the server
 *     recomputes and would not trust anyway;
 *   * a stale preview or a catalogue drift clears the confirmation and demands a freshly displayed
 *     preview. There is no auto-retry: re-showing the operator what they are about to destroy is the
 *     entire point of the digest.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface AcademyDeletionPreview {
  preview_version: number;
  academy_profile_id: string;
  /** Relation → row count that WILL be deleted. */
  deleted: Record<string, number>;
  /** Relation → row count that will be DETACHED, not deleted. */
  detached: Record<string, number>;
  /** Relation → row count that survives but is CHANGED (a scrub, a rederive). */
  mutated: Record<string, number>;
  blockers: Array<{ code: string; count: number }>;
  digest: string;
}

/** Refusals that invalidate the preview the operator is looking at. */
export const STALE_CODES = ["PREVIEW_STALE", "ACADEMY_DELETION_CATALOG_DRIFT"] as const;

export class AcademyDeletionError extends Error {
  readonly code: string | null;
  readonly auditIncomplete: boolean;
  constructor(message: string, code: string | null, auditIncomplete = false) {
    super(message);
    this.name = "AcademyDeletionError";
    this.code = code;
    this.auditIncomplete = auditIncomplete;
  }
}

/** A preview with any blocker must never be given a destructive confirmation. */
export function isPreviewBlocked(preview: AcademyDeletionPreview | null): boolean {
  return !!preview && preview.blockers.length > 0;
}

/** Whether this refusal means "what you were shown is no longer true". */
export function isStalePreview(error: unknown): boolean {
  const code = error instanceof AcademyDeletionError ? error.code : null;
  return !!code && (STALE_CODES as readonly string[]).includes(code);
}

/** Total rows to be destroyed — for a headline the operator reads before confirming. */
export function totalDeleted(preview: AcademyDeletionPreview): number {
  return Object.values(preview.deleted).reduce((a, b) => a + b, 0);
}

export function totalDetached(preview: AcademyDeletionPreview): number {
  return Object.values(preview.detached).reduce((a, b) => a + b, 0);
}

/**
 * Rows that survive the deletion in a changed form. Neither destroyed nor merely unlinked: a
 * `person_merge_review` audit row scrubbed of who it was about, a shared person rewritten from the
 * sources that remain. Showing these as "deleted" would overstate the damage and showing nothing
 * would hide it, so they get their own line.
 */
export function totalMutated(preview: AcademyDeletionPreview): number {
  return Object.values(preview.mutated ?? {}).reduce((a, b) => a + b, 0);
}

/** Only relations with something in them — a wall of zeros hides the rows that matter. */
export function nonZeroEntries(counts: Record<string, number>): Array<[string, number]> {
  return Object.entries(counts).filter(([, n]) => n > 0).sort(([a], [b]) => a.localeCompare(b));
}

async function invoke(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.functions.invoke("admin-academy-deletion", { body });
  if (error) {
    // supabase-js puts the function's JSON body on the error context for non-2xx replies.
    const ctxBody = (error as { context?: { body?: unknown } }).context?.body as
      | Record<string, unknown>
      | undefined;
    throw new AcademyDeletionError(
      String(ctxBody?.error ?? error.message ?? "Academy deletion request failed"),
      (ctxBody?.code as string | undefined) ?? null,
      ctxBody?.audit_incomplete === true,
    );
  }
  const payload = (data ?? {}) as Record<string, unknown>;
  if (payload.error) {
    throw new AcademyDeletionError(
      String(payload.error),
      (payload.code as string | undefined) ?? null,
      payload.audit_incomplete === true,
    );
  }
  return payload;
}

export async function fetchAcademyDeletionPreview(
  supabase: SupabaseClient,
  academyProfileId: string,
): Promise<AcademyDeletionPreview> {
  const payload = await invoke(supabase, { action: "preview", academy_profile_id: academyProfileId });
  return payload.preview as AcademyDeletionPreview;
}

/**
 * Confirm, sending ONLY what the server issued.
 *
 * Refuses locally on a blocked preview rather than letting the request out: the server would refuse
 * too, but a UI that offers a destructive action it knows will be rejected is a UI that teaches
 * people to click through warnings.
 */
export async function confirmAcademyDeletion(
  supabase: SupabaseClient,
  preview: AcademyDeletionPreview,
): Promise<Record<string, unknown>> {
  if (isPreviewBlocked(preview)) {
    throw new AcademyDeletionError(
      "This academy cannot be deleted while it has blockers.",
      "BLOCKED",
    );
  }
  return invoke(supabase, {
    action: "confirm",
    academy_profile_id: preview.academy_profile_id,
    expected_digest: preview.digest,
    preview_version: preview.preview_version,
  });
}
