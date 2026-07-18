import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Trainers from './Trainers';

// The directory wrapper is the unit under test's data source — spy on it.
const { searchMock, facetsMock, fromMock } = vi.hoisted(() => ({
  searchMock: vi.fn(),
  facetsMock: vi.fn(),
  fromMock: vi.fn(),
}));

vi.mock('@/lib/publicTrainerDirectory', () => ({
  searchPublicTrainers: (...a: unknown[]) => searchMock(...a),
  getPublicTrainerDirectoryFacets: (...a: unknown[]) => facetsMock(...a),
}));

// supabase is only allowed to fetch rating_systems now — never trainer_profiles_safe.
vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (table: string) => {
      fromMock(table);
      return { select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [] }) }) }) };
    },
  },
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/hooks/useLocalizedPath', () => ({ useLocalizedPathFn: () => (p: string) => p }));
vi.mock('@/hooks/useMarketingNamespace', () => ({ useMarketingNamespace: () => true }));
vi.mock('@/lib/cities', () => ({ getPopularCities: () => Promise.resolve([]) }));
vi.mock('@/components/SEO', () => ({ SEO: () => null }));
vi.mock('@/lib/structuredData', () => ({ buildBreadcrumbList: () => ({}) }));

vi.mock('@/components/trainers/TrainerFilters', () => ({
  DEFAULT_FILTERS: {
    locationId: 'all', minRating: 0, minExperience: 0, specializations: [], certifications: [],
    verifiedOnly: false, ratingSystem: '', minTrainerRating: 0, hasAvailability: false,
  },
  TrainerFilters: () => <div data-testid="trainer-filters" />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOpts?: unknown) =>
      typeof fallbackOrOpts === 'string' ? fallbackOrOpts : key,
    i18n: { language: 'en' },
  }),
}));

function renderAt(url: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/:lang/trainers" element={<Trainers />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const oneTrainer = (over = {}) => ({
  trainer_profile_id: 't1', slug: 's1', full_name: 'Ada', avatar_url: null, bio: 'b',
  location: 'City', experience_years: 3, certifications: [], specializations: [],
  is_verified: false, average_rating: 4.5, review_count: 2, has_availability: true, ...over,
});

describe('Trainers directory (server-side)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    facetsMock.mockResolvedValue({ locations: [], specializations: [], certifications: [] });
    searchMock.mockResolvedValue({ trainers: [oneTrainer()], totalCount: 1 });
  });

  it('calls the directory RPC wrapper with URL-derived params', async () => {
    searchMock.mockResolvedValue({ trainers: [oneTrainer()], totalCount: 100 }); // page 2 in bounds
    renderAt('/en/trainers?search=ada&page=2&minRating=3&sort=experience&verified=true&locationId=loc-9');
    await waitFor(() => expect(searchMock).toHaveBeenCalled());
    const arg = searchMock.mock.calls.at(-1)![0];
    expect(arg).toMatchObject({
      search: 'ada', page: 2, minRating: 3, sort: 'experience',
      verified: true, locationId: 'loc-9', pageSize: 48,
    });
  });

  it('never issues the old unbounded trainer_profiles_safe select', async () => {
    renderAt('/en/trainers');
    await waitFor(() => expect(searchMock).toHaveBeenCalled());
    expect(fromMock.mock.calls.flat()).not.toContain('trainer_profiles_safe');
    expect(fromMock.mock.calls.flat()).not.toContain('profiles_public');
  });

  it('paginates off the server total_count, not the returned page length', async () => {
    // One page of results, but a large TOTAL → multiple pages must render.
    searchMock.mockResolvedValue({ trainers: [oneTrainer()], totalCount: 100 });
    renderAt('/en/trainers');
    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument());
    // ceil(100/48) = 3 pages → the last-page link "3" only exists if total_count drove it
    // (the returned page held a single trainer).
    await waitFor(() => expect(screen.getByText('3')).toBeInTheDocument());
  });

  it('resets to page 1 when the search changes', async () => {
    searchMock.mockResolvedValue({ trainers: [oneTrainer()], totalCount: 100 }); // page 2 valid
    renderAt('/en/trainers?page=2');
    await waitFor(() => expect(searchMock).toHaveBeenCalled());
    expect(searchMock.mock.calls.at(-1)![0]).toMatchObject({ page: 2 });

    fireEvent.change(screen.getByPlaceholderText('Search trainers by name, specialty...'), {
      target: { value: 'ada' },
    });
    await waitFor(() => {
      const last = searchMock.mock.calls.at(-1)![0];
      expect(last).toMatchObject({ search: 'ada', page: 1 });
    });
  });
});
