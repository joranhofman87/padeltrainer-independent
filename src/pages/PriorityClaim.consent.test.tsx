import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import PriorityClaimPage from './PriorityClaim';
import * as pc from '@/lib/priorityClaims';

vi.mock('@/lib/priorityClaims', () => ({
  fetchClaimByToken: vi.fn(),
  fetchRebookGroupByToken: vi.fn(),
  declineClaimWithToken: vi.fn(),
  acceptClaimAndStartPayment: vi.fn(),
  createGroupRebookInvoice: vi.fn(),
  sendRebookGroupConfirmations: vi.fn(),
  getCycleRebookPaymentMode: vi.fn(),
  getCycleStartDate: vi.fn(),
  recordRebookRulesConsent: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }) }));
vi.mock('react-helmet-async', () => ({ Helmet: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/components/cycles/RebookGroupEditor', () => ({ RebookGroupEditor: () => null }));

const m = vi.mocked;

function setupClaim(rules: string | null) {
  m(pc.fetchClaimByToken).mockResolvedValue({
    claim: { id: 'c1', status: 'pending', claim_token: 'tok' },
    slot: {
      id: 's1', start_time: '2026-09-01T10:00:00Z', end_time: '2026-09-01T11:00:00Z',
      cyclus_id: 'cy1', cyclus_name: 'Cycle', location_id: null, price_per_session: 10,
      total_price: null, priority_window_ends_at: null, trainer_id: 'tr1',
    },
    sessions: 1, player_name: 'Sam', booked_by_captain_name: null, rebook_rules: rules,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  m(pc.getCycleRebookPaymentMode).mockResolvedValue('deferred_split');
  m(pc.getCycleStartDate).mockResolvedValue('2026-09-01');
  m(pc.fetchRebookGroupByToken).mockResolvedValue(null);
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/claim/tok']}>
      <Routes>
        <Route path="/claim/:token" element={<PriorityClaimPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PriorityClaim — rebooking rules consent gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('with rules: "keep my spot" is disabled until the consent box is ticked', async () => {
    setupClaim('<p>Pay within 7 days.</p>');
    renderPage();
    const keep = await screen.findByRole('button', { name: /Yes, keep my spot/ });
    expect(keep).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I agree to the rebooking rules/));
    await waitFor(() => expect(keep).not.toBeDisabled());
  });

  it('records consent BEFORE accepting, then proceeds', async () => {
    setupClaim('<p>rules</p>');
    m(pc.recordRebookRulesConsent).mockResolvedValue();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    m(pc.acceptClaimAndStartPayment).mockResolvedValue({ ok: true, mode: 'deferred' } as any);
    renderPage();
    fireEvent.click(await screen.findByLabelText(/I agree to the rebooking rules/));
    fireEvent.click(screen.getByRole('button', { name: /Yes, keep my spot/ }));
    await waitFor(() => expect(pc.recordRebookRulesConsent).toHaveBeenCalledWith('tok'));
    expect(pc.acceptClaimAndStartPayment).toHaveBeenCalledWith('tok');
    const consentOrder = m(pc.recordRebookRulesConsent).mock.invocationCallOrder[0];
    const acceptOrder = m(pc.acceptClaimAndStartPayment).mock.invocationCallOrder[0];
    expect(consentOrder).toBeLessThan(acceptOrder);
  });

  it('without rules: "keep my spot" is enabled immediately and no consent is recorded', async () => {
    setupClaim(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    m(pc.acceptClaimAndStartPayment).mockResolvedValue({ ok: true, mode: 'deferred' } as any);
    renderPage();
    const keep = await screen.findByRole('button', { name: /Yes, keep my spot/ });
    expect(keep).not.toBeDisabled();
    fireEvent.click(keep);
    await waitFor(() => expect(pc.acceptClaimAndStartPayment).toHaveBeenCalled());
    expect(pc.recordRebookRulesConsent).not.toHaveBeenCalled();
  });

  it('decline is never gated by the rules', async () => {
    setupClaim('<p>rules</p>');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    m(pc.declineClaimWithToken).mockResolvedValue({} as any);
    renderPage();
    const decline = await screen.findByRole('button', { name: /No, release my spot/ });
    expect(decline).not.toBeDisabled();
  });
});
