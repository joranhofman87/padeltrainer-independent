import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface SignupNameFieldsProps {
  firstName: string;
  lastName: string;
  onFirstNameChange: (value: string) => void;
  onLastNameChange: (value: string) => void;
  errors: { firstName?: string; lastName?: string };
}

export function SignupNameFields({
  firstName,
  lastName,
  onFirstNameChange,
  onLastNameChange,
  errors,
}: SignupNameFieldsProps) {
  const { t } = useTranslation('auth');

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="signup-firstName">{t('form.firstName')}</Label>
        <Input
          id="signup-firstName"
          name="firstName"
          type="text"
          autoComplete="given-name"
          placeholder={t('form.firstNamePlaceholder')}
          value={firstName}
          onChange={(e) => onFirstNameChange(e.target.value)}
          className={errors.firstName ? 'border-destructive' : ''}
          aria-invalid={!!errors.firstName}
          required
          data-testid="input-signup-firstName"
        />
        {errors.firstName && <p className="text-sm text-destructive">{errors.firstName}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="signup-lastName">{t('form.lastName')}</Label>
        <Input
          id="signup-lastName"
          name="lastName"
          type="text"
          autoComplete="family-name"
          placeholder={t('form.lastNamePlaceholder')}
          value={lastName}
          onChange={(e) => onLastNameChange(e.target.value)}
          className={errors.lastName ? 'border-destructive' : ''}
          aria-invalid={!!errors.lastName}
          required
          data-testid="input-signup-lastName"
        />
        {errors.lastName && <p className="text-sm text-destructive">{errors.lastName}</p>}
      </div>
    </>
  );
}
