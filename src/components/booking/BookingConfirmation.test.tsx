import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { BookingConfirmation } from './BookingConfirmation';

// Mock react-router-dom
const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

describe('BookingConfirmation', () => {
  it('renders request_sent variant with trainer name', () => {
    render(<BookingConfirmation type="request_sent" trainerName="Jan de Vries" />);
    expect(screen.getByText('Request Sent!')).toBeInTheDocument();
    expect(screen.getByText(/Jan de Vries/)).toBeInTheDocument();
  });

  it('renders booked variant with confirmation', () => {
    render(<BookingConfirmation type="booked" trainerName="Maria Silva" />);
    expect(screen.getByText('Booking Confirmed!')).toBeInTheDocument();
    expect(screen.getByText(/Maria Silva/)).toBeInTheDocument();
  });

  it('shows manual invoicing notice when enabled', () => {
    render(<BookingConfirmation type="booked" trainerName="Test" useManualInvoicing />);
    expect(screen.getByText(/invoice from the trainer/i)).toBeInTheDocument();
  });

  it('hides manual invoicing notice by default', () => {
    render(<BookingConfirmation type="booked" trainerName="Test" />);
    expect(screen.queryByText(/invoice from the trainer/i)).not.toBeInTheDocument();
  });

  it('has navigation buttons', () => {
    render(<BookingConfirmation type="booked" trainerName="Test" />);
    expect(screen.getByText('View My Bookings')).toBeInTheDocument();
    expect(screen.getByText('Browse Other Trainers')).toBeInTheDocument();
  });
});
