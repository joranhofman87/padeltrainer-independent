import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

interface SubscriptionTrialBannerProps {
  /** Expired trials render the destructive Alert and a primary (default-variant) CTA. */
  expired: boolean;
  /** Optional AlertTitle — the canonical trainer banner has none; club/academy keep theirs. */
  title?: ReactNode;
  /** Caller-translated banner copy — the component owns layout/style only. */
  message: ReactNode;
  ctaLabel: string;
  onCtaClick: () => void;
}

/**
 * Presentational subscription-trial banner shared by the trainer, club and
 * academy dashboards. Layout/style follow the canonical TrainerTrialBanner
 * (neutral border, AlertTriangle, CTA flips outline→default on expiry); each
 * role passes its OWN i18n strings, render conditions and CTA target — share
 * the leaf, not the business rule.
 */
export function SubscriptionTrialBanner({
  expired,
  title,
  message,
  ctaLabel,
  onCtaClick,
}: SubscriptionTrialBannerProps) {
  return (
    <Alert variant={expired ? 'destructive' : 'default'} className="mb-6 border-border/80">
      <AlertTriangle className="h-4 w-4" />
      {title != null && <AlertTitle>{title}</AlertTitle>}
      <AlertDescription className="flex items-center justify-between">
        <span>{message}</span>
        <Button size="sm" variant={expired ? 'default' : 'outline'} onClick={onCtaClick}>
          {ctaLabel}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
