import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";

/** Invoke slack-notify with service role. Never throws. */
export async function notifySlackEdge(
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseKey) return;
    const supabase = createClient(supabaseUrl, supabaseKey);
    await supabase.functions.invoke("slack-notify", {
      body: { event, data },
      headers: { Authorization: `Bearer ${supabaseKey}` },
    });
  } catch {
    // Silent — alerts must not break primary flows
  }
}

export async function notifySlackEdgeError(
  functionName: string,
  errorMessage: string,
  context?: Record<string, unknown>,
): Promise<void> {
  await notifySlackEdge("edge_function_error", {
    function: functionName,
    error: errorMessage.slice(0, 500),
    ...context,
  });
}

/**
 * Like notifySlackEdge but RETURNS whether the invoke succeeded, for callers that must
 * only mark work done after a confirmed delivery (e.g. at-least-once required alerts).
 * Still never throws.
 */
export async function notifySlackEdgeResult(
  event: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseKey) return false;
    const supabase = createClient(supabaseUrl, supabaseKey);
    const { error } = await supabase.functions.invoke("slack-notify", {
      body: { event, data },
      headers: { Authorization: `Bearer ${supabaseKey}` },
    });
    return !error;
  } catch {
    return false;
  }
}
