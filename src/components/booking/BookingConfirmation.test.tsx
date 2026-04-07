import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { BookingConfirmation } from './BookingConfirmation';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

describe('BookingConfirmation', () => {
  it('renders request_sent variant with trainer name', () => {
    const { getByText } = render(<BookingConfirmation type="request_sent" trainerName="Jan de Vries" />);
    expect(getByText('Request Sent!')).toBeInTheDocument();
    expect(getByText(/Jan de Vries/)).toBeInTheDocument();
  });

  it('renders booked variant with confirmation', () => {
    const { getByText } = render(<BookingConfirmation type="booked" trainerName="Maria Silva" />);
    expect(getByText('Booking Confirmed!')).toBeInTheDocument();
    expect(getByText(/Maria Silva/)).toBeInTheDocument();
  });

  it('shows manual invoicing notice when enabled', () => {
    const { getByText } = render(<BookingConfirmation type="booked" trainerName="Test" useManualInvoicing />);
    expect(getByText(/invoice from the trainer/i)).toBeInTheDocument();
  });

  it('hides manual invoicing notice by default', () => {
    const { queryByText } = render(<BookingConfirmation type="booked" trainerName="Test" />);
    expect(queryByText(/invoice from the trainer/i)).not.toBeInTheDocument();
  });

  it('has navigation buttons', () => {
    const { getByText } = render(<BookingConfirmation type="booked" trainerName="Test" />);
    expect(getByText('View My Bookings')).toBeInTheDocument();
    expect(getByText('Browse Other Trainers')).toBeInTheDocument();
  });
});
