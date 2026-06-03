import * as React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type PasswordInputProps = Omit<React.ComponentProps<typeof Input>, 'type'> & {
  showToggle?: boolean;
};

export const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, showToggle = true, disabled, id, 'aria-invalid': ariaInvalid, ...props }, ref) => {
    const [visible, setVisible] = useState(false);
    const { t } = useTranslation('auth');

    const toggleLabel = visible
      ? t('trainerSignup.password.hide')
      : t('trainerSignup.password.show');

    return (
      <div className="relative">
        <Input
          ref={ref}
          id={id}
          type={visible ? 'text' : 'password'}
          disabled={disabled}
          aria-invalid={ariaInvalid}
          className={cn(showToggle && 'pr-10', className)}
          {...props}
        />
        {showToggle && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-0 top-0 h-10 w-10 text-muted-foreground hover:text-foreground"
            onClick={() => setVisible((v) => !v)}
            disabled={disabled}
            aria-label={toggleLabel}
            aria-pressed={visible}
            tabIndex={-1}
          >
            {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        )}
      </div>
    );
  },
);

PasswordInput.displayName = 'PasswordInput';
