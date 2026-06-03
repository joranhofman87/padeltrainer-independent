import { z } from 'zod';
import type { TFunction } from 'i18next';
import { buildFullName, splitFullName } from '@/lib/profileName';

export function createSignupSchema(t: TFunction) {
  return z.object({
    firstName: z.string().trim().min(2, t('validation.firstNameRequired')),
    lastName: z.string().trim().min(2, t('validation.lastNameRequired')),
    email: z.string().trim().email('Please enter a valid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
  });
}

/** @deprecated Use buildFullName from profileName — kept for existing imports. */
export function combineRegistrationFullName(firstName: string, lastName: string): string {
  return buildFullName(firstName, lastName);
}

/** Split prefill full name (camelCase for signup forms). */
export function splitPrefillFullName(name: string): { firstName: string; lastName: string } {
  const { first_name, last_name } = splitFullName(name);
  return { firstName: first_name, lastName: last_name };
}
