import { describe, it, expect } from 'vitest';
import {
  buildAcademyInvoiceGuestInsert,
  buildTrainerInvoiceGuestInsert,
  invoiceGuestNameFields,
} from './invoiceGuestPlayerInsert';

describe('invoiceGuestNameFields', () => {
  it('splits full name into first_name, last_name, and full_name', () => {
    expect(invoiceGuestNameFields('Jan van der Meer')).toEqual({
      first_name: 'Jan',
      last_name: 'van der Meer',
      full_name: 'Jan van der Meer',
    });
  });

  it('handles single-token names', () => {
    expect(invoiceGuestNameFields('Madonna')).toEqual({
      first_name: 'Madonna',
      last_name: null,
      full_name: 'Madonna',
    });
  });
});

describe('buildAcademyInvoiceGuestInsert', () => {
  it('includes structured names, email, and academy_profile_id', () => {
    const payload = buildAcademyInvoiceGuestInsert(
      'Jane Player',
      'jane@example.com',
      'academy-1',
    );

    expect(payload.first_name).toBe('Jane');
    expect(payload.last_name).toBe('Player');
    expect(payload.full_name).toBe('Jane Player');
    expect(payload.email).toBe('jane@example.com');
    expect(payload.academy_profile_id).toBe('academy-1');
  });
});

describe('buildTrainerInvoiceGuestInsert', () => {
  it('includes structured names, email, and trainer_id', () => {
    const payload = buildTrainerInvoiceGuestInsert(
      'Piet Jansen',
      'piet@example.com',
      'trainer-1',
    );

    expect(payload.first_name).toBe('Piet');
    expect(payload.last_name).toBe('Jansen');
    expect(payload.full_name).toBe('Piet Jansen');
    expect(payload.email).toBe('piet@example.com');
    expect(payload.trainer_id).toBe('trainer-1');
  });
});
