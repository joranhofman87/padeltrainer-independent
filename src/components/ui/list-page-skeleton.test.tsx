import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ListPageSkeleton } from './list-page-skeleton';

describe('ListPageSkeleton', () => {
  it('renders header, toolbar, and table skeleton regions', () => {
    const { container } = render(<ListPageSkeleton />);
    expect(container.querySelectorAll('[class*="animate-pulse"]').length).toBeGreaterThanOrEqual(3);
  });
});
