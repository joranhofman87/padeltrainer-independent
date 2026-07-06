// PhoneInput — the shared phone field: validates on blur (Dutch or international
// +CC), clears the error live once corrected, and reports required-emptiness.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PhoneInput } from '@/components/ui/phone-input';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

function Harness({ initial = '', required = false }: { initial?: string; required?: boolean }) {
  return <Controlled initial={initial} required={required} />;
}

import { useState } from 'react';
function Controlled({ initial, required }: { initial: string; required: boolean }) {
  const [v, setV] = useState(initial);
  return <PhoneInput value={v} onChange={setV} required={required} aria-label="phone" />;
}

describe('PhoneInput', () => {
  it('shows the invalid error on blur for an implausible number', () => {
    render(<Harness initial="123" />);
    fireEvent.blur(screen.getByLabelText('phone'));
    expect(screen.getByText('validation.phoneInvalid')).toBeInTheDocument();
  });

  it.each(['0612345678', '+31 6 12345678', '+49 170 1234567'])(
    'accepts %s silently',
    (phone) => {
      render(<Harness initial={phone} />);
      fireEvent.blur(screen.getByLabelText('phone'));
      expect(screen.queryByText('validation.phoneInvalid')).not.toBeInTheDocument();
    },
  );

  it('empty value: silent when optional, flagged when required', () => {
    const { unmount } = render(<Harness initial="" />);
    fireEvent.blur(screen.getByLabelText('phone'));
    expect(screen.queryByText('validation.phoneRequired')).not.toBeInTheDocument();
    unmount();

    render(<Harness initial="" required />);
    fireEvent.blur(screen.getByLabelText('phone'));
    expect(screen.getByText('validation.phoneRequired')).toBeInTheDocument();
  });

  it('clears the error live while typing a correction', () => {
    render(<Harness initial="123" />);
    const input = screen.getByLabelText('phone');
    fireEvent.blur(input);
    expect(screen.getByText('validation.phoneInvalid')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: '0612345678' } });
    expect(screen.queryByText('validation.phoneInvalid')).not.toBeInTheDocument();
  });
});
