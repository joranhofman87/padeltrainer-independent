/**
 * Shared phone-number field — THE input for every surface that collects a phone
 * number (booking, registration, signup, profile and player/trainer editors).
 *
 * Validates on blur via the canonical `validatePhone` (Dutch formats or an
 * international +CC number) and shows the translated inline error itself, so
 * call sites only swap their <Input type="tel"> for this component. Blocking a
 * SUBMIT on an invalid value stays the form's job: call `validatePhone(value,
 * required)` in the submit handler (the `auth`-namespace key it returns is the
 * same message this component shows).
 *
 * Deliberately NOT a country-picker/auto-formatting widget: numbers are stored
 * as typed (backends and WhatsApp links cope), we only refuse implausible ones.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { validatePhone } from '@/lib/validation';

interface PhoneInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Adds the required check on blur (the form still enforces it on submit). */
  required?: boolean;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  autoComplete?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}

export function PhoneInput({
  value,
  onChange,
  required = false,
  id,
  placeholder = '+31 6 12345678',
  disabled,
  className,
  autoComplete = 'tel',
  'aria-label': ariaLabel,
  'data-testid': dataTestId,
}: PhoneInputProps) {
  const { t } = useTranslation('auth');
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-1">
      <Input
        id={id}
        data-testid={dataTestId}
        type="tel"
        inputMode="tel"
        value={value}
        disabled={disabled}
        autoComplete={autoComplete}
        aria-label={ariaLabel}
        aria-invalid={!!error}
        placeholder={placeholder}
        className={cn(error && 'border-destructive', className)}
        onChange={(e) => {
          onChange(e.target.value);
          if (error) setError(validatePhone(e.target.value, required));
        }}
        onBlur={() => setError(validatePhone(value, required))}
      />
      {error && <p className="text-xs text-destructive">{t(error)}</p>}
    </div>
  );
}
