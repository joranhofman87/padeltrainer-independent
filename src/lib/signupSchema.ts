import { z } from 'zod';
import type { TFunction } from 'i18next';

export function createSignupSchema(t: TFunction) {
  return z.object({
    firstName: z.string().trim().min(2, t('validation.firstNameRequired')),
    lastName: z.string().trim().min(2, t('validation.lastNameRequired')),
    email: z.string().trim().email('Please enter a valid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
  });
}

/** Split a prefill full name into first / last (conservative: first token + remainder). */
export function splitPrefillFullName(name: string): { firstName: string; lastName: string } {
  const trimmed = name.trim();
  if (!trimmed) {
    return { firstName: '', lastName: '' };
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: '' };
  }
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}
