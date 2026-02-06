/**
 * Supabase client using standard localStorage.
 * 
 * With single-domain routing (no more subdomains), we no longer need
 * cross-subdomain cookie sharing. Standard localStorage is reliable.
 *
 * Import this instead of the auto-generated client:
 *   import { supabase } from "@/lib/supabaseClient";
 */
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    storage: localStorage,
    persistSession: true,
    autoRefreshToken: true,
  },
});
