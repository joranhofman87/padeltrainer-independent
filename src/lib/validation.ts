import { z } from 'zod';

// Dutch phone number regex - supports:
// +31 6 12345678, 06-12345678, 0612345678, +31612345678, 0031 6 12345678
const dutchPhoneRegex = /^(\+31|0031|0)[\s.-]?[1-9][\s.-]?(\d[\s.-]?){7,8}$/;

/**
 * Phone validation schema - optional
 * Accepts empty strings and valid Dutch phone numbers
 */
export const phoneSchema = z.string()
  .transform(val => val.trim())
  .refine(val => val === '' || dutchPhoneRegex.test(val.replace(/[\s.-]/g, '')), {
    message: 'validation.phoneInvalid',
  });

/**
 * Phone validation schema - required
 * Must be a valid Dutch phone number
 */
export const phoneSchemaRequired = z.string()
  .min(1, 'validation.phoneRequired')
  .transform(val => val.trim())
  .refine(val => dutchPhoneRegex.test(val.replace(/[\s.-]/g, '')), {
    message: 'validation.phoneInvalid',
  });

/**
 * Validate a phone number and return error message key if invalid
 */
export function validatePhone(phone: string, required = false): string | null {
  const trimmed = phone.trim();
  
  if (!trimmed) {
    return required ? 'validation.phoneRequired' : null;
  }
  
  const normalized = trimmed.replace(/[\s.-]/g, '');
  if (!dutchPhoneRegex.test(normalized)) {
    return 'validation.phoneInvalid';
  }
  
  return null;
}

/**
 * Format a phone number for display
 */
export function formatPhoneNumber(phone: string): string {
  const cleaned = phone.replace(/[\s.-]/g, '');
  
  // Format +31 numbers
  if (cleaned.startsWith('+31')) {
    const rest = cleaned.slice(3);
    if (rest.length === 9) {
      return `+31 ${rest.slice(0, 1)} ${rest.slice(1, 5)} ${rest.slice(5)}`;
    }
    return `+31 ${rest}`;
  }
  
  // Format 0031 numbers
  if (cleaned.startsWith('0031')) {
    const rest = cleaned.slice(4);
    if (rest.length === 9) {
      return `+31 ${rest.slice(0, 1)} ${rest.slice(1, 5)} ${rest.slice(5)}`;
    }
    return `+31 ${rest}`;
  }
  
  // Format 06 numbers
  if (cleaned.startsWith('06') && cleaned.length === 10) {
    return `${cleaned.slice(0, 2)} ${cleaned.slice(2, 6)} ${cleaned.slice(6)}`;
  }
  
  // Format other Dutch numbers
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    return `${cleaned.slice(0, 3)} ${cleaned.slice(3, 6)} ${cleaned.slice(6)}`;
  }
  
  return phone;
}

/**
 * Password strength calculation
 */
export interface PasswordStrength {
  score: number; // 0-4
  level: 'weak' | 'fair' | 'good' | 'strong';
  checks: {
    minLength: boolean;
    hasUppercase: boolean;
    hasLowercase: boolean;
    hasNumber: boolean;
    hasSpecial: boolean;
  };
}

export function calculatePasswordStrength(password: string): PasswordStrength {
  const checks = {
    minLength: password.length >= 6,
    hasUppercase: /[A-Z]/.test(password),
    hasLowercase: /[a-z]/.test(password),
    hasNumber: /\d/.test(password),
    hasSpecial: /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password),
  };
  
  // Calculate score based on checks
  let score = 0;
  if (checks.minLength) score++;
  if (checks.hasUppercase && checks.hasLowercase) score++;
  if (checks.hasNumber) score++;
  if (checks.hasSpecial) score++;
  
  // Bonus for length > 8
  if (password.length >= 10 && score < 4) score++;
  
  // Cap at 4
  score = Math.min(score, 4);
  
  // Determine level
  let level: PasswordStrength['level'];
  if (score <= 1) level = 'weak';
  else if (score === 2) level = 'fair';
  else if (score === 3) level = 'good';
  else level = 'strong';
  
  return { score, level, checks };
}
