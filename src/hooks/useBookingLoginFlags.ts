// Phase 3.5c: React wrapper around fetchBookingLoginFlags — refetches when the
// booking-id set changes; returns an empty map until loaded (callers fall back
// to their seat-based value, i.e. today's behavior).
import { useEffect, useMemo, useState } from 'react';
import { fetchBookingLoginFlags } from '@/lib/bookingLoginFlags';

export function useBookingLoginFlags(bookingIds: Array<string | null | undefined>): Map<string, boolean> {
  const [flags, setFlags] = useState<Map<string, boolean>>(() => new Map());
  // Stable dependency: the sorted unique id set as a string.
  const key = useMemo(
    () => [...new Set(bookingIds.filter((id): id is string => !!id))].sort().join(','),
    [bookingIds],
  );
  useEffect(() => {
    let cancelled = false;
    if (!key) { setFlags(new Map()); return; }
    fetchBookingLoginFlags(key.split(',')).then((map) => {
      if (!cancelled) setFlags(map);
    });
    return () => { cancelled = true; };
  }, [key]);
  return flags;
}
