// ErrorBoundary: a stale-chunk failure (routine after every deploy) must render the
// quiet "loading the new version" state while its auto-reload is pending — NOT the
// red error card that made post-deploy navigation look like a crash. Genuine errors
// keep the card.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from '@/components/ErrorBoundary';

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const Thrower = ({ message }: { message: string }) => {
  throw new Error(message);
};

beforeEach(() => {
  sessionStorage.clear();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { reload: vi.fn() },
  });
  // React logs caught render errors loudly — irrelevant noise for these assertions.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('ErrorBoundary', () => {
  it('stale chunk: shows the quiet updating state, never the error card', () => {
    render(
      <ErrorBoundary>
        <Thrower message="Failed to fetch dynamically imported module: https://x/assets/Page-abc.js" />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('chunk-reload-fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('error-boundary-fallback')).not.toBeInTheDocument();
    expect(screen.getByText(/nieuwe versie|new version/i)).toBeInTheDocument();
  });

  it('genuine error: keeps the full error card', () => {
    render(
      <ErrorBoundary>
        <Thrower message="Cannot read properties of undefined (reading 'boom')" />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary-fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('chunk-reload-fallback')).not.toBeInTheDocument();
  });
});
