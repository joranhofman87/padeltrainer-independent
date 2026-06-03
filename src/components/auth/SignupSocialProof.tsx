import { useTranslation } from 'react-i18next';
import { Quote } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SignupRoleKey } from '@/components/auth/SignupRoleTabs';

interface SignupSocialProofProps {
  role: SignupRoleKey;
  className?: string;
}

export function SignupSocialProof({ role, className }: SignupSocialProofProps) {
  const { t } = useTranslation('auth');
  const prefix = `${role}Signup.socialProof`;

  return (
    <div
      className={cn(
        'space-y-3 rounded-lg border border-border/60 bg-muted/30 px-4 py-4',
        className,
      )}
      data-testid={`signup-social-proof-${role}`}
    >
      <div className="flex gap-3">
        <Quote className="h-5 w-5 shrink-0 text-primary/80" aria-hidden />
        <blockquote className="text-sm text-foreground leading-relaxed">
          {t(`${prefix}.quote`)}
        </blockquote>
      </div>
      <p className="text-xs text-muted-foreground pl-8">
        — {t(`${prefix}.attribution`)}
      </p>
      <p className="text-xs text-muted-foreground border-t border-border/50 pt-3">
        {t(`${prefix}.trust`)}
      </p>
    </div>
  );
}
