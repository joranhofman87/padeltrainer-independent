import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ListPageState } from '@/components/ui/list-page-shell';
import type { ReadinessEnvelope } from './types';

export function OpsStatusBadge({ status }: { status: string }) {
  const variant = status === 'pass' ? 'default' : status === 'fail' ? 'destructive' : 'secondary';
  return <Badge variant={variant} data-testid={`status-${status}`}>{status}</Badge>;
}

/** The versioned readiness envelope — every named check rendered verbatim, including the
 *  not_provable ones (the env switch and the N5-dependent checks). */
export function ReadinessPanel({
  envelope, isLoading, isError, onRetry,
}: { envelope?: ReadinessEnvelope; isLoading: boolean; isError: boolean; onRetry: () => void }) {
  const { t } = useTranslation('admin');
  return (
    <section aria-label="readiness" data-testid="section-readiness">
      <h2 className="font-medium">{t('notifOps.readiness', 'Readiness')}</h2>
      <ListPageState
        isLoading={isLoading}
        error={isError ? (
          <span>
            {t('notifOps.loadFailed', { defaultValue: 'Could not load {{label}} — the real state is unknown.', label: 'readiness' })}
            <Button size="sm" variant="outline" className="ml-2" onClick={onRetry} data-testid="readiness-retry">
              {t('notifOps.retry', 'Retry')}
            </Button>
          </span>
        ) : undefined}
      >
        {envelope ? (
          <div data-testid="readiness-envelope">
            <p className="text-sm">
              {t('notifOps.overall', 'Overall')}: <OpsStatusBadge status={envelope.readiness} />{' '}
              <span className="text-muted-foreground">v{envelope.schema_version} · {envelope.as_of}</span>
            </p>
            <ul className="mt-2 space-y-1 text-sm">
              {envelope.checks.map((c) => (
                <li key={c.id} data-testid={`check-${c.id}`} className="break-words">
                  <OpsStatusBadge status={c.status} /> <strong>{c.id}</strong>: {c.detail}
                  {c.capped ? <em> {t('notifOps.capped', '(saturated count)')}</em> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </ListPageState>
    </section>
  );
}
