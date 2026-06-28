import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the two telemetry sinks so we can assert what the helper emits without touching PostHog.
const trackEvent = vi.fn();
const warn = vi.fn();
vi.mock('@/lib/tracking', () => ({ trackEvent: (...a: unknown[]) => trackEvent(...a) }));
vi.mock('@/lib/logger', () => ({ logger: { warn: (...a: unknown[]) => warn(...a) } }));

import { isMissingRpc, reportDeployDriftFallback } from '@/lib/deployDrift';

describe('isMissingRpc — canonical "server function not live yet" check', () => {
  it('is true for the missing-function codes (PGRST202 schema-cache miss / 42883 no such function)', () => {
    expect(isMissingRpc({ code: 'PGRST202' })).toBe(true);
    expect(isMissingRpc({ code: '42883' })).toBe(true);
  });

  it('is false for any other or absent error code (so real errors still propagate)', () => {
    expect(isMissingRpc({ code: 'PGRST301' })).toBe(false);
    expect(isMissingRpc({ code: '23505' })).toBe(false);
    expect(isMissingRpc({})).toBe(false);
    expect(isMissingRpc(null)).toBe(false);
    expect(isMissingRpc(undefined)).toBe(false);
    expect(isMissingRpc(new Error('boom'))).toBe(false);
  });
});

describe('reportDeployDriftFallback', () => {
  beforeEach(() => {
    trackEvent.mockReset();
    warn.mockReset();
  });

  it('fires a queryable deploy_drift_fallback event tagged with the feature + detail', () => {
    reportDeployDriftFallback('get_trainer_earnings_summary', { trainerId: 't1' });
    expect(trackEvent).toHaveBeenCalledWith('deploy_drift_fallback', {
      feature: 'get_trainer_earnings_summary',
      trainerId: 't1',
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('works with no detail', () => {
    reportDeployDriftFallback('count_cycles_intakes');
    expect(trackEvent).toHaveBeenCalledWith('deploy_drift_fallback', { feature: 'count_cycles_intakes' });
  });

  it('never throws even if a telemetry sink throws (must not break the fallback path)', () => {
    trackEvent.mockImplementation(() => {
      throw new Error('posthog down');
    });
    expect(() => reportDeployDriftFallback('get_academy_cyclus_groups', { academyId: 'a1' })).not.toThrow();
  });
});
