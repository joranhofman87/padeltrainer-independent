import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import i18n from 'i18next';
import enCycles from '@/i18n/locales/en/cycles.json';
import enCommon from '@/i18n/locales/en/common.json';

// AcademyRebookManage reads the academy context + the rebook status query. Mock the context, and
// partial-mock rebookManage so ONLY getCycleRebookStatus is replaced (everything else stays real).
vi.mock('@/components/academy/AcademyLayout', () => ({
  useAcademyContext: () => ({ activeAcademy: { id: 'ac1', timezone: 'Europe/Amsterdam' } }),
}));
const getStatusMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/rebookManage', async (orig) => {
  const actual = await orig<typeof import('@/lib/rebookManage')>();
  return { ...actual, getCycleRebookStatus: (...a: unknown[]) => getStatusMock(...a) };
});

import AcademyRebookManage from '@/pages/academy/AcademyRebookManage';

const inst = i18n.createInstance();
void inst.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { cycles: enCycles, common: enCommon } },
  ns: ['cycles', 'common'],
  defaultNS: 'cycles',
  interpolation: { escapeValue: false },
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={inst}>
        <MemoryRouter initialEntries={['/app/academy/cycles/cy1/rebook']}>
          <Routes>
            <Route path="/app/academy/cycles/:cycleId/rebook" element={<AcademyRebookManage />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('AcademyRebookManage error/retry state (Codex round-6 #5)', () => {
  it('renders the TRANSLATED error + a retry button that refetches (keys resolve, not the Dutch fallback)', async () => {
    getStatusMock.mockReset();
    getStatusMock.mockRejectedValue(new Error('load boom'));
    renderPage();

    // The English cycles.json values — proves rebookManage.loadFailedTitle/loadFailedBody EXIST (an
    // English user would otherwise see the Dutch inline fallback).
    expect(await screen.findByText('Could not load the rebooking')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong while fetching the data. Please try again.')).toBeInTheDocument();

    const retry = screen.getByRole('button', { name: /Try again/i });
    expect(retry).toBeInTheDocument();

    // Clicking retry re-runs getCycleRebookStatus (react-query refetch).
    const before = getStatusMock.mock.calls.length;
    fireEvent.click(retry);
    await waitFor(() => expect(getStatusMock.mock.calls.length).toBeGreaterThan(before));
  });
});
