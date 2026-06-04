import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkAcademyConnectStatus,
  connectAcademyMollie,
  disconnectAcademyMollie,
} from './academyPayments';

const invokeMock = vi.fn();

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    functions: { invoke: (...args: unknown[]) => invokeMock(...args) },
  },
}));

describe('academyPayments auth headers', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ data: { connected: true, paymentReady: true }, error: null });
  });

  it('checkAcademyConnectStatus passes Authorization header', async () => {
    await checkAcademyConnectStatus('academy-id', 'user-jwt-token');
    expect(invokeMock).toHaveBeenCalledWith('check-mollie-connect-status', {
      body: { entityType: 'academy', entityId: 'academy-id' },
      headers: { Authorization: 'Bearer user-jwt-token' },
    });
  });

  it('connectAcademyMollie passes Authorization header', async () => {
    invokeMock.mockResolvedValue({ data: { url: 'https://mollie.test/oauth' }, error: null });
    await connectAcademyMollie('academy-id', 'user-jwt-token');
    expect(invokeMock).toHaveBeenCalledWith('mollie-connect-academy', {
      body: { academyProfileId: 'academy-id' },
      headers: { Authorization: 'Bearer user-jwt-token' },
    });
  });

  it('disconnectAcademyMollie passes Authorization header', async () => {
    invokeMock.mockResolvedValue({ data: { success: true }, error: null });
    await disconnectAcademyMollie('academy-id', 'user-jwt-token');
    expect(invokeMock).toHaveBeenCalledWith('mollie-disconnect-academy', {
      body: { academyProfileId: 'academy-id' },
      headers: { Authorization: 'Bearer user-jwt-token' },
    });
  });

  it('throws when access token is missing', async () => {
    await expect(checkAcademyConnectStatus('academy-id', '')).rejects.toThrow('Not authenticated');
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
