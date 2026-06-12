import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, RefreshCw, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface FeatureErrorFallbackProps {
  error?: Error | null;
  onRetry?: () => void;
  onBack?: () => void;
  title?: string;
  description?: string;
  compact?: boolean;
}

/**
 * A compact error fallback for feature-level error boundaries.
 * Use this when you want errors to be contained to a section of the page
 * rather than breaking the entire application.
 */
export function FeatureErrorFallback({
  error,
  onRetry,
  onBack,
  title,
  description,
  compact = false,
}: FeatureErrorFallbackProps) {
  const { t } = useTranslation('common');
  const isDev = import.meta.env.DEV;

  const resolvedTitle = title || t('errorBoundary.title', 'Something went wrong');
  const resolvedDescription =
    description ||
    t('errorBoundary.sectionDescription', 'This section could not be loaded. You can try again or navigate elsewhere.');

  if (compact) {
    return (
      <div className="flex items-center gap-4 p-4 bg-destructive/10 border border-destructive/20 rounded-lg">
        <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-destructive">{resolvedTitle}</p>
          {isDev && error && (
            <p className="text-xs text-muted-foreground truncate">{error.message}</p>
          )}
        </div>
        {onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry} aria-label={t('errorBoundary.retry', 'Try again')}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        )}
      </div>
    );
  }

  return (
    <Card className="border-destructive/20">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-full bg-destructive/10">
            <AlertTriangle className="h-5 w-5 text-destructive" />
          </div>
          <CardTitle className="text-lg">{resolvedTitle}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{resolvedDescription}</p>

        {isDev && error && (
          <div className="p-3 bg-muted rounded-md overflow-auto max-h-24">
            <code className="text-xs text-destructive break-all">
              {error.message}
            </code>
          </div>
        )}

        <div className="flex gap-2">
          {onBack && (
            <Button variant="outline" size="sm" onClick={onBack}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              {t('errorBoundary.back', 'Go back')}
            </Button>
          )}
          {onRetry && (
            <Button size="sm" onClick={onRetry}>
              <RefreshCw className="h-4 w-4 mr-2" />
              {t('errorBoundary.retry', 'Try again')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default FeatureErrorFallback;
