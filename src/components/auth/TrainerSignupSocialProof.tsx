import { useTranslation } from 'react-i18next';
import { Quote } from 'lucide-react';
import { cn } from '@/lib/utils';

interface TrainerSignupSocialProofProps {
  className?: string;
}

export function TrainerSignupSocialProof({ className }: TrainerSignupSocialProofProps) {
  const { t } = useTranslation('auth');

  return (
    <div
      className={cn(
        'space-y-3 rounded-lg border border-border/60 bg-muted/30 px-4 py-4',
        className,
      )}
    >
      <div className="flex gap-3">
        <Quote className="h-5 w-5 shrink-0 text-primary/80" aria-hidden />
        <blockquote className="text-sm text-foreground leading-relaxed">
          {t('trainerSignup.socialProof.quote')}
        </blockquote>
      </div>
      <p className="text-xs text-muted-foreground pl-8">
        — {t('trainerSignup.socialProof.attribution')}
      </p>
      <p className="text-xs text-muted-foreground border-t border-border/50 pt-3">
        {t('trainerSignup.socialProof.trust')}
      </p>
    </div>
  );
}
