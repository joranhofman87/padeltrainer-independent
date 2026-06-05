import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

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
