import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlayerColumnsMenu } from './PlayerColumnsMenu';
import type { ColumnDescriptor } from './useVisibleColumns';

const cols: ColumnDescriptor<'a' | 'b'>[] = [
  { key: 'a', label: 'Alpha', isDefault: true },
  { key: 'b', label: 'Beta', isDefault: false },
];
const labels = { button: 'Columns', default: 'Default', optional: 'Optional' };

describe('PlayerColumnsMenu', () => {
  it('renders the trigger button with the injected label', () => {
    render(<PlayerColumnsMenu allColumns={cols} isColVisible={() => true} onToggle={vi.fn()} labels={labels} />);
    expect(screen.getByRole('button', { name: /Columns/ })).toBeInTheDocument();
  });
  // The open/toggle behaviour is Radix's (portal + pointer events); the wrapper only forwards
  // allColumns/isColVisible/onToggle into checkbox items, so the trigger render is the contract here.
});
