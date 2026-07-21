import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// PR 9: the booking WhatsApp opt-in checkbox. Meta requires opt-in that names the business and
// the channel, and enforcement is mechanical — recipients blocking or reporting drives the
// sender's quality rating down and can get the number disabled. So the two things pinned here
// are that it is never pre-checked and never offered without a number to send to.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, def?: string, opts?: Record<string, unknown>) => {
      const template = typeof def === 'string' ? def : key;
      return template.replace(/\{\{(\w+)\}\}/g, (_m, n) => String((opts ?? {})[n] ?? ''));
    },
  }),
}));

import { WhatsAppOptInField } from '@/components/booking/WhatsAppOptInField';

const setup = (over: Partial<React.ComponentProps<typeof WhatsAppOptInField>> = {}) => {
  const onCheckedChange = vi.fn();
  render(
    <WhatsAppOptInField
      id="wa"
      checked={false}
      onCheckedChange={onCheckedChange}
      phone="+31612345678"
      {...over}
    />,
  );
  return { onCheckedChange };
};

describe('WhatsAppOptInField', () => {
  it('is UNCHECKED by default', () => {
    setup();
    expect(screen.getByTestId('whatsapp-optin')).not.toBeChecked();
  });

  it('renders NOTHING without a usable number', () => {
    // an opt-in with nothing to send to is a promise we cannot keep
    for (const phone of ['', '   ', null, undefined]) {
      const { container } = render(
        <WhatsAppOptInField id="wa" checked={false} onCheckedChange={vi.fn()} phone={phone} />,
      );
      expect(container).toBeEmptyDOMElement();
    }
  });

  it('reports the tick to the caller', () => {
    const { onCheckedChange } = setup();
    fireEvent.click(screen.getByTestId('whatsapp-optin'));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('names what will be sent, not just "WhatsApp"', () => {
    // Meta rejects vague consent; the label has to say what the person is agreeing to receive.
    // Inline defaults are Dutch, matching this codebase's convention for booking copy.
    setup();
    expect(screen.getByText(/herinnering voor deze training/i)).toBeInTheDocument();
    expect(screen.getByText(/altijd stoppen/i)).toBeInTheDocument();
  });

  it('shows the number when asked, so a confirmed profile phone is visible', () => {
    // BookLesson does not otherwise display the phone, so consent would be blind without this
    setup({ showNumber: true });
    expect(screen.getByText(/\+31612345678/)).toBeInTheDocument();
  });

  it('does not leak the number into the label when showNumber is off', () => {
    setup({ showNumber: false });
    expect(screen.queryByText(/\+31612345678/)).toBeNull();
  });

  it('discloses the profile save when ticking also stores the number', () => {
    // consent to be MESSAGED is not consent to keep data on the account — where the tick does
    // both, the label has to say both, or the consent granted is narrower than the action taken
    setup({ savesToProfile: true });
    expect(screen.getByTestId('whatsapp-optin-profile-note')).toBeInTheDocument();
    expect(screen.getByText(/bewaren dit nummer bij je profiel/i)).toBeInTheDocument();
  });

  it('says nothing about the profile when nothing is stored there', () => {
    setup({ savesToProfile: false });
    expect(screen.queryByTestId('whatsapp-optin-profile-note')).toBeNull();
  });
});
