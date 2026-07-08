import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { PlayerMultiSelect, type PlayerMultiSelectOption } from './PlayerMultiSelect';

// Radix Popover + cmdk need these DOM APIs jsdom lacks.
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

const OPTIONS: PlayerMultiSelectOption[] = [
  { id: 'a', full_name: 'Anna Appel', email: 'anna@example.com' },
  { id: 'b', full_name: 'Bob Bal', email: 'bob@example.com' },
  { id: 'c', full_name: 'Cas Court', email: 'cas@example.com' },
];

function open(testId = 'picker') {
  fireEvent.click(screen.getByTestId(testId));
}

describe('PlayerMultiSelect', () => {
  it('opens the picker and lists every option', () => {
    render(
      <PlayerMultiSelect
        options={OPTIONS}
        selectedIds={[]}
        onToggle={() => {}}
        triggerLabel="Zoek en selecteer spelers"
        searchPlaceholder="Zoek"
        emptyLabel="Niets"
        data-testid="picker"
      />,
    );
    open();
    expect(screen.getAllByTestId('player-multiselect-option')).toHaveLength(3);
    expect(screen.getByText('Anna Appel')).toBeInTheDocument();
  });

  it('toggles a player and KEEPS the popover open so several can be picked in one pass', () => {
    const onToggle = vi.fn();
    render(
      <PlayerMultiSelect
        options={OPTIONS}
        selectedIds={[]}
        onToggle={onToggle}
        triggerLabel="Zoek en selecteer spelers"
        searchPlaceholder="Zoek"
        emptyLabel="Niets"
        data-testid="picker"
      />,
    );
    open();

    fireEvent.click(screen.getByText('Anna Appel'));
    expect(onToggle).toHaveBeenCalledWith('a');

    // Still open → a second pick needs no reopen.
    const options = screen.getAllByTestId('player-multiselect-option');
    expect(options.length).toBe(3);
    fireEvent.click(screen.getByText('Bob Bal'));
    expect(onToggle).toHaveBeenCalledWith('b');
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it('marks already-selected players', () => {
    render(
      <PlayerMultiSelect
        options={OPTIONS}
        selectedIds={['b']}
        onToggle={() => {}}
        triggerLabel="Zoek en selecteer spelers"
        searchPlaceholder="Zoek"
        emptyLabel="Niets"
        data-testid="picker"
      />,
    );
    open();
    const rows = screen.getAllByTestId('player-multiselect-option');
    const bob = rows.find((r) => within(r).queryByText('Bob Bal'));
    const anna = rows.find((r) => within(r).queryByText('Anna Appel'));
    expect(bob?.getAttribute('data-picked')).toBe('true');
    expect(anna?.getAttribute('data-picked')).toBe('false');
  });
});
