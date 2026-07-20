// Notification Foundation v2 — PR 9: WhatsApp Content Template DEFINITIONS.
//
// These are committed and REVIEWED before anything is created in Twilio or submitted to Meta.
// A submitted template goes in front of Meta under the business's identity and cannot be
// quietly deleted, so the definition has to exist here first — the same "no unreviewable
// production artifact" rule that the twilio-content-admin function itself had to learn.
//
// The `variables` array is the POSITIONAL CONTRACT: Twilio fills {{1}}, {{2}}, … by index, so
// the order here must match the order the worker supplies them. Getting it wrong doesn't error
// — it silently sends someone a time where their name should be. Hence it is named, ordered
// and pinned by a test rather than left implicit.
//
// Meta formatting rules these bodies satisfy (the usual rejection causes):
//   * must not START or END with a variable
//   * no two variables adjacent
//   * variables numbered sequentially from {{1}}
//
// CATEGORY matters: a reminder is UTILITY, never MARKETING. The wrong category risks rejection
// and costs more per message.

export type TemplateCategory = "UTILITY" | "MARKETING" | "AUTHENTICATION";

export interface WhatsAppTemplate {
  /** notification_event_types.key this template renders. */
  eventType: string;
  /** Twilio Content friendly_name (internal, free-form). */
  friendlyName: string;
  /** Meta template name — lowercase_with_underscores. */
  approvalName: string;
  category: TemplateCategory;
  /** BCP-47-ish language code as Twilio expects it. */
  language: string;
  /** Body with {{1}}..{{n}} placeholders. */
  body: string;
  /** Ordered, named positional contract for {{1}}..{{n}}. */
  variables: string[];
  /** Sample values, in the same order — Meta requires samples at review time. */
  samples: string[];
  /** Env var that will hold the APPROVED Content SID (HX…). Absent SID ⇒ worker must not send. */
  contentSidEnv: string;
}

/**
 * PILOT: the session reminder. Chosen deliberately — genuinely useful on WhatsApp, NOT on the
 * money path, and it mirrors how PR 5 piloted email on a low-risk notification before the
 * paid-booking chain.
 *
 * It is currently the ONLY event that supports WhatsApp, and that is not a coincidence:
 * notification_event_types.supports_whatsapp means "a committed template exists for this
 * event", so this file IS the capability list. Other events are CANDIDATES, not supported —
 * enabling one means committing its template here (body + samples + contentSidEnv), getting it
 * approved, setting the env var, and only then flipping supports_whatsapp. A cross-layer test
 * fails if the catalog ever claims more than this array delivers.
 */
export const SESSION_REMINDER_NL: WhatsAppTemplate = {
  eventType: "session_reminder_player",
  friendlyName: "session_reminder_player_nl",
  approvalName: "session_reminder_player_nl",
  category: "UTILITY",
  language: "nl",
  body: "Hoi {{1}}, herinnering voor je training: {{2}} om {{3}} bij {{4}}. Tot dan!",
  variables: ["first_name", "date", "time", "location"],
  samples: ["Tom", "maandag 3 maart", "10:00", "Hal 1"],
  contentSidEnv: "TWILIO_TEMPLATE_SESSION_REMINDER_NL",
};

export const WHATSAPP_TEMPLATES: WhatsAppTemplate[] = [SESSION_REMINDER_NL];

export function templateForEvent(eventType: string, language = "nl"): WhatsAppTemplate | null {
  return WHATSAPP_TEMPLATES.find((t) => t.eventType === eventType && t.language === language) ?? null;
}

/** Positional {{n}} → value map for Twilio's ContentVariables, built from the named contract. */
export function buildContentVariables(
  template: WhatsAppTemplate,
  values: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  template.variables.forEach((name, i) => {
    out[String(i + 1)] = values[name] ?? "";
  });
  return out;
}

/** Meta's structural rules, enforced here so a bad body fails a test rather than a review. */
export function validateTemplateBody(body: string): { valid: boolean; problems: string[] } {
  const problems: string[] = [];
  const trimmed = body.trim();
  if (/^\{\{\d+\}\}/.test(trimmed)) problems.push("body must not start with a variable");
  if (/\{\{\d+\}\}$/.test(trimmed)) problems.push("body must not end with a variable");
  if (/\}\}\s*\{\{/.test(trimmed)) problems.push("variables must not be adjacent");
  const nums = [...trimmed.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  const expected = nums.map((_, i) => i + 1);
  if (nums.join(",") !== expected.join(",")) problems.push("variables must be sequential from {{1}}");
  return { valid: problems.length === 0, problems };
}
