import { AlertCircle, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type QueryErrorStateProps = {
  /** Re-runs the failed fetch — pass the useQuery refetch or the page's fetch function. */
  onRetry: () => void;
  title?: string;
  description?: string;
  className?: string;
};

/**
 * Shared error state for failed data queries. Render it where the empty/zero
 * state would otherwise appear, so a fetch failure never looks like deleted data.
 */
export function QueryErrorState({ onRetry, title, description, className }: QueryErrorStateProps) {
  const { t } = useTranslation('common');

  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-border/80 bg-card px-4 py-10 text-center shadow-sm',
        className,
      )}
    >
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-destructive/10">
        <AlertCircle className="h-5 w-5 text-destructive" />
      </div>
      <h3 className="text-sm font-semibold text-foreground">
        {title || t('queryError.title', 'Could not load data')}
      </h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {description || t('queryError.description', 'Something went wrong while loading. Your data is safe — check your connection and try again.')}
      </p>
      <Button variant="outline" size="sm" className="mt-4" onClick={() => onRetry()}>
        <RefreshCw className="mr-2 h-4 w-4" />
        {t('queryError.retry', 'Try again')}
      </Button>
    </div>
  );
}
