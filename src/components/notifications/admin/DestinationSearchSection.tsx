import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabaseClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { SearchRow } from './types';

/** Exact-match destination lookup: masked echo + saturating counts, rate-limited server-side. */
export function DestinationSearchSection() {
  const { t } = useTranslation('admin');
  const [input, setInput] = useState('');
  const [result, setResult] = useState<SearchRow | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const epoch = useRef(0);

  const run = async () => {
    const myEpoch = ++epoch.current;
    setResult(null);
    setMessage(null);
    const { data, error } = await supabase.rpc('admin_search_notification_destination', { p_destination: input });
    if (myEpoch !== epoch.current) return;
    if (error) { setMessage(error.message); return; }
    setResult(((data ?? []) as SearchRow[])[0] ?? null);
  };

  return (
    <section aria-label="destination search" data-testid="section-search">
      <h2 className="font-medium">{t('notifOps.search', 'Destination lookup')}</h2>
      <p className="text-sm text-muted-foreground">
        {t('notifOps.searchScope', 'Exact normalized email or E.164 number only — no partial search exists, by design. Lookups are rate-limited and logged.')}
      </p>
      <div className="flex flex-wrap gap-2 py-2">
        <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="name@example.com"
          data-testid="search-input" className="max-w-xs" />
        <Button size="sm" variant="outline" onClick={() => void run()} data-testid="search-btn">
          {t('notifOps.lookup', 'Look up')}
        </Button>
      </div>
      {message && <p role="alert" className="text-sm break-words" data-testid="search-message">{message}</p>}
      {result && (
        <p className="text-sm break-words" data-testid="search-result">
          {result.destination_masked} · {t('notifOps.contacts', 'contacts')}: {result.contacts}{result.contacts_capped ? '+' : ''} ·{' '}
          {t('notifOps.outboxRows', 'outbox')}: {result.outbox_rows}{result.outbox_capped ? '+' : ''} ·{' '}
          {t('notifOps.deliveryEvents', 'delivery events')}: {result.delivery_events}{result.events_capped ? '+' : ''}
        </p>
      )}
    </section>
  );
}
