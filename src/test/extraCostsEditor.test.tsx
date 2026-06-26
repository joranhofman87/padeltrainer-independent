import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithCycles } from './renderWithCycles';
import { ExtraCostsEditor, type ExtraCost } from '@/components/slots/ExtraCostsEditor';

const rows: ExtraCost[] = [
  { description: 'Balls', amount: 5, type: 'one_time' },
  { description: 'Court', amount: 10, type: 'per_session' },
];

describe('ExtraCostsEditor (F3b shared, D2-aligned)', () => {
  it('renders a row per cost INCLUDING the one_time/per_session select for the trainer namespace (D2 align)', () => {
    renderWithCycles(<ExtraCostsEditor value={rows} onChange={() => {}} namespace="trainer" />);
    expect(screen.getByDisplayValue('Balls')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Court')).toBeInTheDocument();
    // The whole point of D2: the type select (academy-only before) now renders for trainer too.
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
  });

  it('Add appends a row defaulting to one_time (default unchanged, purely additive)', () => {
    const onChange = vi.fn();
    renderWithCycles(<ExtraCostsEditor value={rows} onChange={onChange} namespace="trainer" />);
    fireEvent.click(screen.getByRole('button', { name: /add|toevoegen/i }));
    expect(onChange).toHaveBeenCalledWith([...rows, { description: '', amount: 0, type: 'one_time' }]);
  });

  it('editing description / amount emits the updated array (only that row changes)', () => {
    const onChange = vi.fn();
    renderWithCycles(<ExtraCostsEditor value={rows} onChange={onChange} namespace="trainer" />);
    fireEvent.change(screen.getByDisplayValue('Balls'), { target: { value: 'Shuttles' } });
    expect(onChange).toHaveBeenLastCalledWith([{ ...rows[0], description: 'Shuttles' }, rows[1]]);
    fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '7' } });
    expect(onChange).toHaveBeenLastCalledWith([{ ...rows[0], amount: 7 }, rows[1]]);
  });

  it('remove drops just that row', () => {
    const onChange = vi.fn();
    renderWithCycles(<ExtraCostsEditor value={rows} onChange={onChange} namespace="trainer" />);
    fireEvent.click(screen.getAllByRole('button', { name: /remove|verwijder/i })[0]);
    expect(onChange).toHaveBeenCalledWith([rows[1]]);
  });

  it('disabled (cycle slot): no add/remove, inputs disabled', () => {
    renderWithCycles(<ExtraCostsEditor value={rows} onChange={() => {}} disabled namespace="academy" />);
    expect(screen.queryByRole('button', { name: /add|toevoegen/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove|verwijder/i })).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('Balls')).toBeDisabled();
  });
});
