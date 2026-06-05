import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppBootstrapGate } from './AppBootstrapGate';

const useAuthMock = vi.fn();

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => useAuthMock(),
}));

function renderGate(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/app/academy"
          element={
            <AppBootstrapGate>
              <div data-testid="app-content">Academy content</div>
            </AppBootstrapGate>
          }
        />
        <Route
          path="/app/auth"
          element={
            <AppBootstrapGate>
              <div data-testid="auth-content">Auth content</div>
            </AppBootstrapGate>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AppBootstrapGate', () => {
  it('shows shell skeleton while auth is loading on protected routes', () => {
    useAuthMock.mockReturnValue({
      loading: true,
      profileReady: false,
      user: null,
    });

    renderGate('/app/academy');
    expect(screen.getByTestId('app-shell-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('app-content')).not.toBeInTheDocument();
  });

  it('shows shell skeleton while profile is not ready for signed-in user', () => {
    useAuthMock.mockReturnValue({
      loading: false,
      profileReady: false,
      user: { id: 'user-1' },
    });

    renderGate('/app/academy');
    expect(screen.getByTestId('app-shell-skeleton')).toBeInTheDocument();
  });

  it('renders children when auth profile is ready', () => {
    useAuthMock.mockReturnValue({
      loading: false,
      profileReady: true,
      user: { id: 'user-1' },
    });

    renderGate('/app/academy');
    expect(screen.getByTestId('app-content')).toBeInTheDocument();
    expect(screen.queryByTestId('app-shell-skeleton')).not.toBeInTheDocument();
  });

  it('does not gate public auth route while profile loads', () => {
    useAuthMock.mockReturnValue({
      loading: true,
      profileReady: false,
      user: null,
    });

    renderGate('/app/auth');
    expect(screen.getByTestId('auth-content')).toBeInTheDocument();
    expect(screen.queryByTestId('app-shell-skeleton')).not.toBeInTheDocument();
  });
});
