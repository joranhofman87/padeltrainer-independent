import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SignupValuePanel } from './SignupValuePanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

describe('SignupValuePanel', () => {
  it('renders three benefit bullets per role', () => {
    // eslint-disable-next-line jsx-a11y/aria-role -- `role` is SignupValuePanel's domain prop (user role), not an ARIA role
    render(<SignupValuePanel role="player" />);
    expect(screen.getByTestId('signup-value-panel-player')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });
});
