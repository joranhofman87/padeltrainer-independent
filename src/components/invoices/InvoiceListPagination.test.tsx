import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InvoiceListPagination } from './InvoiceListPagination';

// Previous/Next render their label via i18n (returns the key in tests), so target them by link
// position — first link = Previous, last link = Next. Numbered links render plain {i+1} text.
const prevLink = () => screen.getAllByRole('link')[0];
const nextLink = () => {
  const links = screen.getAllByRole('link');
  return links[links.length - 1];
};

describe('InvoiceListPagination', () => {
  it('renders nothing for a single page', () => {
    const { container } = render(
      <InvoiceListPagination page={0} pageCount={1} onPageChange={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a numbered link per page for a small range', () => {
    render(<InvoiceListPagination page={0} pageCount={3} onPageChange={vi.fn()} />);
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('windows to first/last + ±2 around the current page with an ellipsis', () => {
    render(<InvoiceListPagination page={5} pageCount={20} onPageChange={vi.fn()} />);
    // page index 5 → first(1), window 4..8, last(20); far pages hidden.
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument(); // current (index 5)
    expect(screen.queryByText('10')).not.toBeInTheDocument();
    expect(screen.getAllByText('…').length).toBeGreaterThan(0);
  });

  it('navigates to a clicked page number', () => {
    const onPageChange = vi.fn();
    render(<InvoiceListPagination page={0} pageCount={5} onPageChange={onPageChange} />);
    fireEvent.click(screen.getByText('3'));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it('clamps Previous at the first page and Next at the last page', () => {
    const onFirst = vi.fn();
    const { unmount } = render(
      <InvoiceListPagination page={0} pageCount={5} onPageChange={onFirst} />,
    );
    fireEvent.click(prevLink());
    expect(onFirst).toHaveBeenCalledWith(0); // clamped, never -1
    unmount();

    const onLast = vi.fn();
    render(<InvoiceListPagination page={4} pageCount={5} onPageChange={onLast} />);
    fireEvent.click(nextLink());
    expect(onLast).toHaveBeenCalledWith(4); // clamped, never 5
  });

  it('advances one page from the middle', () => {
    const onPageChange = vi.fn();
    render(<InvoiceListPagination page={2} pageCount={5} onPageChange={onPageChange} />);
    fireEvent.click(nextLink());
    expect(onPageChange).toHaveBeenCalledWith(3);
  });
});
