// IntakeRequestsTable mobile variant (trainer-audit batch 2): the ~10-column
// desktop table is unreadable at phone width — below md each request renders as
// a tappable card (name/email/status/payment chips) opening the same detail
// sheet; the table itself is hidden below md.
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import IntakeRequestsTable from '@/components/cycles/IntakeRequestsTable';
import type { IntakeRequestWithProposal } from '@/lib/cycles';

vi.mock('@/lib/supabaseClient', () => ({ supabase: {} }));

const request = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    id: 'req-1',
    full_name: 'Anna Applicant',
    email: 'anna@example.com',
    phone: null,
    status: 'pending',
    created_at: '2026-07-01T10:00:00Z',
    lesson_type: ['private'],
    rating: null,
    rating_system: null,
    preferred_days: [],
    preferred_time_windows: [],
    invoice_id: 'inv-1',
    invoice_status: 'open',
    ...over,
  }) as unknown as IntakeRequestWithProposal;

describe('IntakeRequestsTable mobile cards', () => {
  it('renders a tappable mobile card per request and hides the table below md', () => {
    const onRowClick = vi.fn();
    const { container } = render(
      <IntakeRequestsTable requests={[request()]} onRowClick={onRowClick} />,
    );

    const mobileList = container.querySelector('.md\\:hidden.divide-y');
    expect(mobileList).not.toBeNull();
    expect(mobileList!.textContent).toContain('Anna Applicant');
    expect(mobileList!.textContent).toContain('anna@example.com');

    fireEvent.click(mobileList!.querySelector('.cursor-pointer')!);
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect((onRowClick.mock.calls[0][0] as { id: string }).id).toBe('req-1');

    // The wide table only exists from md up.
    const tableWrap = container.querySelector('.overflow-x-auto');
    expect(tableWrap?.className).toContain('hidden');
    expect(tableWrap?.className).toContain('md:block');
  });

  it('the card shows the unpaid payment chip when an invoice is open', () => {
    const { container } = render(
      <IntakeRequestsTable requests={[request()]} onRowClick={() => {}} />,
    );
    const mobileList = container.querySelector('.md\\:hidden.divide-y');
    expect(mobileList!.textContent).toMatch(/Unpaid|unpaid/);
  });
});

describe('mobile input font floor (iOS focus-zoom)', () => {
  it('ui Input and Textarea are 16px on mobile, 14px from md up', async () => {
    const { Input } = await import('@/components/ui/input');
    const { Textarea } = await import('@/components/ui/textarea');
    const { container: c1 } = render(<Input />);
    const { container: c2 } = render(<Textarea />);
    expect(c1.querySelector('input')!.className).toMatch(/\btext-base\b.*\bmd:text-sm\b/);
    expect(c2.querySelector('textarea')!.className).toMatch(/\btext-base\b.*\bmd:text-sm\b/);
  });
});
