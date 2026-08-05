import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';

/**
 * The N4/N5 admin surface's always-on reads. Every one of them is the same shape — a named RPC,
 * typed rows, and `retry: false` so a failure is SHOWN (fail-closed: this page must never imply
 *health it could not read) rather than hidden behind a retrying spinner.
 *
 * The query key is namespaced under 'notif-ops', which is what makes a single
 * invalidateQueries(['notif-ops']) after an operational decision refresh exactly these reads.
 */
export function useOpsRead<T>(key: string, rpc: string, args?: Record<string, unknown>) {
  return useQuery({
    queryKey: ['notif-ops', key],
    queryFn: async () => {
      const { data, error } = await supabase.rpc(rpc as never, args as never);
      if (error) throw error;
      return data as T;
    },
    retry: false,
  });
}
