import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MoneyInput } from './money-input';

describe('MoneyInput', () => {
  it('renders the euro symbol and default-size padding', () => {
    render(<MoneyInput aria-label="Price" placeholder="0.00" />);

    expect(screen.getByText('€')).toBeInTheDocument();
    const input = screen.getByLabelText('Price');
    expect(input).toHaveAttribute('type', 'number');
    expect(input.className).toContain('pl-7');
    expect(input.className).not.toContain('h-8');
  });

  it('renders the compact sm variant with h-8 sizing and a text-xs symbol', () => {
    const { container } = render(<MoneyInput size="sm" aria-label="Cost" />);

    const symbol = screen.getByText('€');
    expect(symbol.className).toContain('text-xs');
    expect(symbol.className).toContain('left-2');

    const input = screen.getByLabelText('Cost');
    expect(input.className).toContain('pl-5');
    expect(input.className).toContain('h-8');
    expect(input.className).toContain('text-sm');
    expect(container.querySelector('div.relative')).toBeTruthy();
  });

  it('passes onChange through with the raw event value unchanged', () => {
    const seen: string[] = [];
    const onChange = vi.fn((e: React.ChangeEvent<HTMLInputElement>) => {
      seen.push(e.target.value);
    });
    render(<MoneyInput aria-label="Price" value="" onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '12.34' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['12.34']);
  });

  it('passes min/step/placeholder/id/disabled and wrapperClassName through', () => {
    const { container } = render(
      <MoneyInput
        aria-label="Price"
        min={0}
        step={0.01}
        placeholder="0.00"
        id="price-input"
        disabled
        wrapperClassName="w-24"
      />,
    );

    const input = screen.getByLabelText('Price');
    expect(input).toHaveAttribute('min', '0');
    expect(input).toHaveAttribute('step', '0.01');
    expect(input).toHaveAttribute('placeholder', '0.00');
    expect(input).toHaveAttribute('id', 'price-input');
    expect(input).toBeDisabled();
    expect(container.querySelector('div.relative.w-24')).toBeTruthy();
  });
});
