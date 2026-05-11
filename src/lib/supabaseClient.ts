/**
 * Compatibility re-export.
 *
 * Historically this file created its own Supabase client, which meant the app
 * shipped two GoTrueClient instances (this one + the auto-generated one in
 * src/integrations/supabase/client.ts) with identical config. That triggered
 * "Multiple GoTrueClient instances detected" warnings and split auth state.
 *
 * Both files now resolve to the SAME singleton. Existing imports from either
 * path continue to work unchanged. Prefer the canonical path in new code:
 *
 *   import { supabase } from "@/integrations/supabase/client";
 */
export { supabase } from "@/integrations/supabase/client";
export type { Database } from "@/integrations/supabase/types";
