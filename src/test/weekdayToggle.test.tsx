import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithCycles } from './renderWithCycles';
import { WeekdayToggle } from '@/components/cycles/WeekdayToggle';
import type { Weekday } from '@/lib/slotPlan';

// Buttons render in DAYS order: monday(0) … sunday(6).
const dayButtons = () => screen.getAllByRole('button');

describe('WeekdayToggle', () => {
  it('renders all seven weekdays and marks the selected ones', () => {
    renderWithCycles(<WeekdayToggle value={['monday']} onChange={() => {}} />);
    const buttons = dayButtons();
    expect(buttons).toHaveLength(7);
    expect(buttons[0]).toHaveAttribute('data-state', 'on'); // monday selected
    expect(buttons[1]).toHaveAttribute('data-state', 'off'); // tuesday not
  });

  it('adds a day on click (emits the new Weekday[])', () => {
    const onChange = vi.fn();
    renderWithCycles(<WeekdayToggle value={['monday']} onChange={onChange} />);
    fireEvent.click(dayButtons()[2]); // wednesday
    expect(onChange).toHaveBeenCalledTimes(1);
    const emitted = onChange.mock.calls[0][0] as Weekday[];
    expect(emitted).toEqual(expect.arrayContaining(['monday', 'wednesday']));
  });

  it('removes a selected day on click', () => {
    const onChange = vi.fn();
    renderWithCycles(<WeekdayToggle value={['monday', 'wednesday']} onChange={onChange} />);
    fireEvent.click(dayButtons()[0]); // deselect monday
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual(['wednesday']);
  });
});
