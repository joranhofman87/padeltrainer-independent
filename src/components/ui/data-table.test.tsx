import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { compactDataTableClass, DataTableCard } from './data-table';

describe('compactDataTableClass', () => {
  it('includes h-10 row density and horizontal min width', () => {
    expect(compactDataTableClass).toContain('min-w-[960px]');
    expect(compactDataTableClass).toContain('[&_tbody_tr]:h-10');
    expect(compactDataTableClass).toContain('[&_td]:max-h-10');
    expect(compactDataTableClass).toContain('[&_td]:overflow-hidden');
  });
});

describe('DataTableCard', () => {
  it('renders flush card with scroll region and optional test id', () => {
    render(
      <DataTableCard testId="players-table-scroll">
        <table>
          <tbody>
            <tr>
              <td>Player</td>
            </tr>
          </tbody>
        </table>
      </DataTableCard>,
    );

    expect(screen.getByTestId('players-table-scroll')).toBeInTheDocument();
    expect(screen.getByTestId('players-table-scroll')).toHaveClass('overflow-x-auto');
    expect(screen.getByText('Player')).toBeInTheDocument();
  });

  it('renders optional mobile slot', () => {
    render(
      <DataTableCard testId="table" mobile={<div data-testid="mobile-list">Mobile</div>}>
        <table><tbody><tr><td>Desktop</td></tr></tbody></table>
      </DataTableCard>,
    );

    expect(screen.getByTestId('mobile-list')).toBeInTheDocument();
  });
});
