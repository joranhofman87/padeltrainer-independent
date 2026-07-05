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

  it('renders without an icon: label and value show, no icon bubble in the DOM', () => {
    const { container } = render(<StatTile label="Unpaid" value="€ 50,00" />);
    expect(screen.getByText('Unpaid')).toBeInTheDocument();
    expect(screen.getByText('€ 50,00')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeNull();
    // no empty right-hand bubble either
    expect(container.querySelector('.h-9.w-9')).toBeNull();
  });

  it('accepts a ReactNode value and renders it', () => {
    render(
      <StatTile
        label="Total"
        value={<span data-testid="rich-value">€ 1.234,00</span>}
        icon={Users}
      />,
    );
    expect(screen.getByTestId('rich-value')).toBeInTheDocument();
    expect(screen.getByText('€ 1.234,00')).toBeInTheDocument();
  });

  it('renders endSlot instead of the icon bubble when both are provided', () => {
    const { container } = render(
      <StatTile
        label="Students"
        value="12"
        icon={Users}
        endSlot={<span data-testid="end-slot">extra</span>}
      />,
    );
    expect(screen.getByTestId('end-slot')).toBeInTheDocument();
    // endSlot wins: the Users icon bubble is not rendered
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('.h-9.w-9')).toBeNull();
  });

  it('accepts a ReactNode subtext and renders it', () => {
    render(
      <StatTile
        label="Bookings"
        value="12"
        subtext={<span data-testid="rich-subtext">+5% vs last month</span>}
      />,
    );
    expect(screen.getByTestId('rich-subtext')).toBeInTheDocument();
    expect(screen.getByText('+5% vs last month')).toBeInTheDocument();
  });

  it('applies iconClassName to the icon while keeping the default sizing classes', () => {
    const { container } = render(
      <StatTile label="Students" value="12" icon={Users} iconClassName="text-pink-500" />,
    );
    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('text-pink-500');
    expect(svg).toHaveClass('h-4');
    expect(svg).toHaveClass('w-4');
  });

  it('keeps the default icon color when iconClassName is absent', () => {
    const { container } = render(<StatTile label="Students" value="12" icon={Users} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('h-4');
    expect(svg).toHaveClass('w-4');
    expect(svg).toHaveClass('text-[hsl(var(--navy-600))]');
  });
});
