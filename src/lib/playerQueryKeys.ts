/**
 * Central React Query key factory + invalidation for ALL player data.
 *
 * Every player-related query lives under the ['players', kind, id] subtree so
 * one invalidation call refreshes every view (list, pickers, campaign, counts)
 * — the structural fix for "edited a player here, stale data there".
 */
import type { QueryClient } from '@tanstack/react-query';

export type PlayerScopeKind = 'academy' | 'trainer';

export interface PlayerScope {
  kind: PlayerScopeKind;
  id: string;
}

export const playerKeys = {
  all: ['players'] as const,
  scope: (kind: PlayerScopeKind, id: string | undefined | null) =>
    ['players', kind, id] as const,
  overview: (kind: PlayerScopeKind, id: string | undefined | null, params: unknown) =>
    ['players', kind, id, 'overview', params] as const,
  count: (kind: PlayerScopeKind, id: string | undefined | null) =>
    ['players', kind, id, 'count'] as const,
  campaignAll: (kind: PlayerScopeKind, id: string | undefined | null) =>
    ['players', kind, id, 'campaign-all'] as const,
  picker: (kind: PlayerScopeKind, id: string | undefined | null, search: string) =>
    ['players', kind, id, 'picker', search] as const,
};

/**
 * Invalidate every player-related query for a scope (or all scopes when
 * omitted). Call after ANY write that touches player data: profile/guest
 * edits, tags, notes, removal/restore, has_trained, invoice creation or
 * status changes (overdue flag), imports.
 */
export function invalidateAllPlayerData(qc: QueryClient, scope?: PlayerScope) {
  return scope
    ? qc.invalidateQueries({ queryKey: playerKeys.scope(scope.kind, scope.id) })
    : qc.invalidateQueries({ queryKey: playerKeys.all });
}
