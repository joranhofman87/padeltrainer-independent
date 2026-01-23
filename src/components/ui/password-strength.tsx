import { useTranslation } from 'react-i18next';
import { Check, X } from 'lucide-react';
import { calculatePasswordStrength, PasswordStrength } from '@/lib/validation';
import { cn } from '@/lib/utils';

interface PasswordStrengthIndicatorProps {
  password: string;
  className?: string;
}

export function PasswordStrengthIndicator({ password, className }: PasswordStrengthIndicatorProps) {
  const { t } = useTranslation('auth');
  
  // Don't show anything if password is empty
  if (!password) {
    return null;
  }
  
  const strength = calculatePasswordStrength(password);
  
  const levelColors: Record<PasswordStrength['level'], string> = {
    weak: 'bg-destructive',
    fair: 'bg-yellow-500',
    good: 'bg-green-400',
    strong: 'bg-green-600',
  };
  
  const levelLabels: Record<PasswordStrength['level'], string> = {
    weak: t('passwordStrength.weak', 'Weak'),
    fair: t('passwordStrength.fair', 'Fair'),
    good: t('passwordStrength.good', 'Good'),
    strong: t('passwordStrength.strong', 'Strong'),
  };
  
  return (
    <div className={cn('space-y-2', className)}>
      {/* Strength bar */}
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((index) => (
          <div
            key={index}
            className={cn(
              'h-1.5 flex-1 rounded-full transition-all duration-300',
              index < strength.score
                ? levelColors[strength.level]
                : 'bg-muted'
            )}
          />
        ))}
      </div>
      
      {/* Strength label */}
      <div className="flex items-center justify-between text-xs">
        <span className={cn(
          'font-medium',
          strength.level === 'weak' && 'text-destructive',
          strength.level === 'fair' && 'text-yellow-600 dark:text-yellow-400',
          strength.level === 'good' && 'text-green-600 dark:text-green-400',
          strength.level === 'strong' && 'text-green-700 dark:text-green-300'
        )}>
          {levelLabels[strength.level]}
        </span>
      </div>
      
      {/* Requirements checklist - only show for weak/fair passwords */}
      {(strength.level === 'weak' || strength.level === 'fair') && (
        <ul className="text-xs space-y-0.5 text-muted-foreground">
          <RequirementItem 
            met={strength.checks.minLength} 
            label={t('passwordStrength.requirements.minLength', 'At least 6 characters')} 
          />
          <RequirementItem 
            met={strength.checks.hasUppercase} 
            label={t('passwordStrength.requirements.hasUppercase', 'One uppercase letter')} 
          />
          <RequirementItem 
            met={strength.checks.hasLowercase} 
            label={t('passwordStrength.requirements.hasLowercase', 'One lowercase letter')} 
          />
          <RequirementItem 
            met={strength.checks.hasNumber} 
            label={t('passwordStrength.requirements.hasNumber', 'One number')} 
          />
          <RequirementItem 
            met={strength.checks.hasSpecial} 
            label={t('passwordStrength.requirements.hasSpecial', 'One special character')} 
          />
        </ul>
      )}
    </div>
  );
}

function RequirementItem({ met, label }: { met: boolean; label: string }) {
  return (
    <li className={cn(
      'flex items-center gap-1.5',
      met ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'
    )}>
      {met ? (
        <Check className="h-3 w-3" />
      ) : (
        <X className="h-3 w-3" />
      )}
      {label}
    </li>
  );
}
