import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Users } from 'lucide-react';
import { EmptyState } from './empty-state';

describe('EmptyState', () => {
  it('renders title and description in default variant', () => {
    render(
      <EmptyState
        icon={Users}
        title="No players yet"
        description="Players will appear here once they book."
      />,
    );

    expect(screen.getByText('No players yet')).toBeInTheDocument();
    expect(screen.getByText('Players will appear here once they book.')).toBeInTheDocument();
  });

  it('renders optional action', () => {
    render(
      <EmptyState
        icon={Users}
        title="Empty"
        action={<button type="button">Add player</button>}
      />,
    );

    expect(screen.getByRole('button', { name: 'Add player' })).toBeInTheDocument();
  });

  it('supports trainer variant styling', () => {
    const { container } = render(
      <EmptyState icon={Users} title="Empty" variant="trainer" />,
    );

    expect(container.querySelector('.bg-\\[hsl\\(var\\(--navy-50\\)\\)\\]')).toBeTruthy();
  });
});
