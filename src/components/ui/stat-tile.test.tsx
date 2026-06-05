import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Users } from 'lucide-react';
import { StatTile } from './stat-tile';

describe('StatTile', () => {
  it('renders label and value', () => {
    render(<StatTile label="Students" value="12" icon={Users} />);
    expect(screen.getByText('Students')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('renders as button when onClick is provided', () => {
    render(<StatTile label="Students" value="12" icon={Users} onClick={() => {}} />);
    expect(screen.getByRole('button', { name: /Students/i })).toBeInTheDocument();
  });
});
