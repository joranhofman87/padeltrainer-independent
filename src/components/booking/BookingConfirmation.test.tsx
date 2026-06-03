import { describe, it, expect, vi } from 'vitest';
import { renderWithI18n } from '@/test/renderWithI18n';
import { BookingConfirmation } from './BookingConfirmation';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

describe('BookingConfirmation', () => {
  it('renders request_sent variant with trainer name', () => {
    const { getByText } = renderWithI18n(
      <BookingConfirmation type="request_sent" trainerName="Jan de Vries" />,
    );
    expect(getByText('Request Sent!')).toBeInTheDocument();
    expect(getByText(/Jan de Vries/)).toBeInTheDocument();
  });

  it('renders booked variant with confirmation', () => {
    const { getByText } = renderWithI18n(
      <BookingConfirmation type="booked" trainerName="Maria Silva" />,
    );
    expect(getByText('Booking Confirmed!')).toBeInTheDocument();
    expect(getByText(/Maria Silva/)).toBeInTheDocument();
  });

  it('shows manual invoicing notice when enabled', () => {
    const { getByText } = renderWithI18n(
      <BookingConfirmation type="booked" trainerName="Test" useManualInvoicing />,
    );
    expect(getByText(/invoice from the trainer/i)).toBeInTheDocument();
  });

  it('hides manual invoicing notice by default', () => {
    const { queryByText } = renderWithI18n(
      <BookingConfirmation type="booked" trainerName="Test" />,
    );
    expect(queryByText(/invoice from the trainer/i)).not.toBeInTheDocument();
  });

  it('has navigation buttons', () => {
    const { getByText } = renderWithI18n(
      <BookingConfirmation type="booked" trainerName="Test" />,
    );
    expect(getByText('View My Bookings')).toBeInTheDocument();
    expect(getByText('Browse Other Trainers')).toBeInTheDocument();
  });
});
