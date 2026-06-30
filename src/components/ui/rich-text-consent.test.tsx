import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RichTextConsent, type RichTextConsentProps } from './rich-text-consent';

function setup(overrides: Partial<RichTextConsentProps> = {}) {
  const props: RichTextConsentProps = {
    content: '<p>Be on time. No refunds.</p>',
    accepted: false,
    onAcceptChange: vi.fn(),
    title: 'Rebooking rules',
    checkboxLabel: 'I agree to the rebooking rules',
    ...overrides,
  };
  const utils = render(<RichTextConsent {...props} />);
  return { props, ...utils };
}

describe('RichTextConsent', () => {
  it('renders the title, content and the consent checkbox + label', () => {
    setup();
    expect(screen.getByText('Rebooking rules')).toBeInTheDocument();
    expect(screen.getByText(/Be on time\. No refunds\./)).toBeInTheDocument();
    expect(screen.getByLabelText('I agree to the rebooking rules')).toBeInTheDocument();
  });

  it('ticking the checkbox calls onAcceptChange(true)', () => {
    const { props } = setup();
    fireEvent.click(screen.getByLabelText('I agree to the rebooking rules'));
    expect(props.onAcceptChange).toHaveBeenCalledWith(true);
  });

  it('reflects the controlled accepted state', () => {
    setup({ accepted: true });
    expect(screen.getByRole('checkbox')).toHaveAttribute('data-state', 'checked');
  });

  it('renders nothing when content is null', () => {
    const { container } = setup({ content: null });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when content is an empty string', () => {
    const { container } = setup({ content: '' });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders truthy content as-is (blank-HTML normalization is the caller’s job)', () => {
    // Falsy-only emptiness keeps exact parity with the booking-terms gate (`!!terms && !accepted`):
    // a non-empty-but-visually-blank value still shows the box + checkbox, matching the gate.
    setup({ content: '<p></p>' });
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
  });

  it('loading shows the spinner + loadingLabel and hides the checkbox', () => {
    setup({ loading: true, loadingLabel: 'Loading rules...' });
    expect(screen.getByText('Loading rules...')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('uses an explicit id for the checkbox/label pair when provided', () => {
    setup({ id: 'accept-terms' });
    expect(screen.getByRole('checkbox')).toHaveAttribute('id', 'accept-terms');
  });

  it('auto-generates distinct ids for two instances without an explicit id', () => {
    render(
      <>
        <RichTextConsent content="<p>A</p>" accepted={false} onAcceptChange={vi.fn()} title="A" checkboxLabel="Agree A" />
        <RichTextConsent content="<p>B</p>" accepted={false} onAcceptChange={vi.fn()} title="B" checkboxLabel="Agree B" />
      </>,
    );
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect(boxes[0].id).toBeTruthy();
    expect(boxes[0].id).not.toEqual(boxes[1].id);
  });

  it('accordion variant renders the title as a collapsed disclosure with the checkbox still shown', () => {
    setup({ variant: 'accordion' });
    // The accordion trigger carries the title and is collapsed by default.
    const trigger = screen.getByRole('button', { name: /Rebooking rules/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // The consent checkbox sits OUTSIDE the disclosure, so it is always visible.
    expect(screen.getByLabelText('I agree to the rebooking rules')).toBeInTheDocument();
  });
});
