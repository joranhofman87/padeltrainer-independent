/**
 * Supabase client configured with cookie-based storage for
 * cross-subdomain session sharing (padeltrainer.ai ↔ app.padeltrainer.ai).
 *
 * Import this instead of the auto-generated client:
 *   import { supabase } from "@/lib/supabaseClient";
 */
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { cookieStorage } from './cookieStorage';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    storage: cookieStorage,
    persistSession: true,
    autoRefreshToken: true,
  },
});
