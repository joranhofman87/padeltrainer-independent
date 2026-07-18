// Phase 3.5c: React wrapper around fetchBookingLoginFlags. Uses react-query so
// N cards rendering the same id-set share ONE request (the agenda renders a card
// per slot — a plain useEffect fetch fired one RPC per card, verify r1 P2) and
// results are cached across remounts. Returns an empty map until loaded
// (callers fall back to their seat-based value, i.e. today's behavior).
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchBookingLoginFlags } from '@/lib/bookingLoginFlags';

const EMPTY = new Map<string, boolean>();

export function useBookingLoginFlags(bookingIds: Array<string | null | undefined>): Map<string, boolean> {
  // Stable key: the sorted unique id set.
  const ids = useMemo(
    () => [...new Set(bookingIds.filter((id): id is string => !!id))].sort(),
    [bookingIds],
  );
  const { data } = useQuery({
    queryKey: ['booking-login-flags', ids.join(',')],
    queryFn: () => fetchBookingLoginFlags(ids),
    enabled: ids.length > 0,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
  return data ?? EMPTY;
}
