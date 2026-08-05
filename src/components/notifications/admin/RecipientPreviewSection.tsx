import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabaseClient';
import { DataTable, type ColumnDef } from '@/components/ui/data-table-generic';
import { TableToolbar } from '@/components/ui/table-toolbar';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState } from '@/components/ui/empty-state';
import { ListPageState } from '@/components/ui/list-page-shell';
import { Users } from 'lucide-react';
import { Input } from '@/components/ui/input';
import type { DecisionRow, PreviewRow } from './types';

type Row = PreviewRow & { id: string };

/**
 * The recipient preview. It does NOT use useCursorList: its cursor is a server-returned
 * `next_cursor` with an honest `candidates_partial` signal (a bounded-crawl contract), not a
 * last-row keyset — forcing it into the shared hook would misrepresent both.
 */
export function RecipientPreviewSection({ eventKeys }: { eventKeys: string[] }) {
  const { t } = useTranslation('admin');
  const [eventKey, setEventKey] = useState('');
  const [channel, setChannel] = useState('email');
  const [rows, setRows] = useState<PreviewRow[] | null>(null);
  const [partial, setPartial] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [academy, setAcademy] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const lock = useRef(false);
  // the PROVENANCE drill-down: one user's every contributing source, fail-closed + epoch-guarded
  const [provenanceFor, setProvenanceFor] = useState<string | null>(null);
  const [provenance, setProvenance] = useState<DecisionRow | null>(null);
  const [provenanceError, setProvenanceError] = useState(false);
  const provenanceEpoch = useRef(0);
  const openProvenance = async (userId: string) => {
    const myEpoch = ++provenanceEpoch.current;
    setProvenanceFor(userId);
    setProvenance(null);
    setProvenanceError(false);
    const { data, error: err } = await supabase.rpc('admin_preview_notification_decision', {
      p_user_id: userId,
      p_event_key: eventKey,
      p_channel: channel,
      p_tenant_academy_profile_id: academy.trim() || undefined,
    });
    if (myEpoch !== provenanceEpoch.current) return;
    if (err) { setProvenanceError(true); return; }
    setProvenance(((data ?? []) as DecisionRow[])[0] ?? null);
  };

  const resetScope = () => {
    epoch.current++;
    lock.current = false;
    setRows(null);
    setPartial(false);
    setCursor(null);
    setProvenanceFor(null);   // a previous scope's provenance is not this scope's
    setProvenance(null);
    provenanceEpoch.current++;
    setError(false);          // a previous scope's failure must not linger over a new one
    setBusy(false);           // …nor its in-flight spinner: the superseded response returns
                              // early and would otherwise leave the new scope loading forever
  };
  const load = async (more = false) => {
    if (lock.current) return;
    lock.current = true;
    const myEpoch = ++epoch.current;
    setBusy(true);
    setError(false);
    const { data, error: err } = await supabase.rpc('admin_preview_notification_recipients', {
      p_event_key: eventKey,
      p_channel: channel,
      p_tenant_academy_profile_id: academy.trim() || undefined,
      p_after_user_id: more ? cursor ?? undefined : undefined,
      p_limit: 25,
    });
    if (myEpoch !== epoch.current) return;
    lock.current = false;
    setBusy(false);
    if (err) { setError(true); return; }
    const list = (data ?? []) as PreviewRow[];
    const real = list.filter((r) => r.user_id);
    setRows((prev) => (more && prev ? [...prev, ...real] : real));
    setPartial(list.some((r) => r.candidates_partial === true));
    setCursor(list.length ? (list[list.length - 1].next_cursor ?? null) : null);
  };

  const columns: ColumnDef<Row>[] = [
    { key: 'destination', header: t('notifOps.destination', 'Destination'), className: 'max-w-[240px]',
      cellTitle: (r) => r.destination_masked ?? undefined,
      renderCell: (r) => <span className="block truncate">{r.destination_masked ?? '—'}</span> },
    { key: 'decision', header: t('notifOps.decision', 'Decision'), className: 'max-w-[240px] whitespace-nowrap',
      cellTitle: (r) => r.final_decision,
      renderCell: (r) => <span className="block truncate">{r.final_decision}</span> },
  ];

  return (
    <section aria-label="recipient preview" data-testid="section-preview">
      <h2 className="font-medium">{t('notifOps.preview', 'Recipient preview')}</h2>
      <p className="text-sm text-muted-foreground">
        {t('notifOps.previewScope', 'Previews resolver state (preferences, caps, consent, suppression) for known users — not a producer’s audience.')}
      </p>
      <TableToolbar className="py-2">
        <Select value={eventKey} onValueChange={(v) => { setEventKey(v); resetScope(); }}>
          <SelectTrigger className="w-[240px]" data-testid="preview-event">
            <SelectValue placeholder={t('notifOps.chooseEvent', 'choose event…')} />
          </SelectTrigger>
          <SelectContent>
            {eventKeys.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={channel} onValueChange={(v) => { setChannel(v); resetScope(); }}>
          <SelectTrigger className="w-[160px]" data-testid="preview-channel"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="email">email</SelectItem>
            <SelectItem value="whatsapp">whatsapp</SelectItem>
          </SelectContent>
        </Select>
        <Input value={academy} onChange={(e) => { setAcademy(e.target.value); resetScope(); }}
          placeholder={t('notifOps.academyCtx', 'academy id (optional) — for tenant caps')}
          data-testid="preview-academy" className="max-w-[320px]" />
        <Button size="sm" variant="outline" onClick={() => void load(false)} disabled={!eventKey} data-testid="preview-load">
          {t('notifOps.preview', 'Preview')}
        </Button>
      </TableToolbar>
      {rows === null && !error && !busy ? null : (
        <ListPageState
          isLoading={busy && rows === null}
          error={error ? (
            <span>
              {t('notifOps.loadFailed', { defaultValue: 'Could not load {{label}} — the real state is unknown.', label: 'recipient preview' })}
              <Button size="sm" variant="outline" className="ml-2" onClick={() => void load(false)} data-testid="preview-retry">
                {t('notifOps.retry', 'Retry')}
              </Button>
            </span>
          ) : undefined}
          isEmpty={(rows?.length ?? 0) === 0 && !partial}
          empty={<EmptyState icon={Users} title={t('notifOps.previewEmpty', 'No recipients for this event')}
            description={t('notifOps.previewEmptyDesc', 'No known user resolves to a delivery for this event and channel.')} />}
        >
          <div data-testid="preview-list">
            {partial && (
              <p role="status" className="text-sm text-amber-600" data-testid="preview-partial">
                {t('notifOps.partial', 'PARTIAL: the candidate scan hit its budget — users beyond the horizon are omitted from this page; continue to crawl them.')}
              </p>
            )}
            <DataTable<Row>
              columns={columns}
              rows={(rows ?? []).map((r) => ({ ...r, id: r.user_id }))}
              renderActions={(r) => (
                <Button size="sm" variant="ghost" onClick={() => void openProvenance(r.user_id)}
                  data-testid={`provenance-btn-${r.user_id}`}>
                  {t('notifOps.why', 'Why?')}
                </Button>
              )}
              compact
              desktopOnly={false}
              empty={t('notifOps.previewEmpty', 'No recipients for this event')}
            />
            {provenanceFor && (
              <div className="mt-2 rounded-md border p-3" data-testid="provenance-panel">
                <p className="text-sm font-medium">
                  {t('notifOps.provenanceFor', { defaultValue: 'Effective preference — {{id}}', id: provenanceFor })}
                </p>
                {provenanceError ? (
                  <p role="alert" className="text-sm">
                    {t('notifOps.loadFailed', { defaultValue: 'Could not load {{label}} — the real state is unknown.', label: 'provenance' })}
                    <Button size="sm" variant="outline" className="ml-2" onClick={() => void openProvenance(provenanceFor)}>
                      {t('notifOps.retry', 'Retry')}
                    </Button>
                  </p>
                ) : provenance ? (
                  <ul className="space-y-1 text-sm" data-testid="provenance-list">
                    {/* EVERY contributing source, each its own line — the finding-10 contract */}
                    <li>{t('notifOps.pvCatalog', 'catalog')}: {provenance.catalog_supported ? provenance.catalog_default : t('notifOps.unsupported', 'unsupported')}{provenance.required_delivery ? ' · required' : ''}</li>
                    <li>{t('notifOps.pvExplicit', 'explicit preference')}: {provenance.explicit_preference ?? '—'}</li>
                    <li>{t('notifOps.pvOptin', 'whatsapp booking opt-in arm')}: {provenance.whatsapp_optin_arm ? t('notifOps.yes', 'yes') : '—'}</li>
                    <li>{t('notifOps.pvCap', 'academy cap')}: {provenance.academy_cap ?? '—'}{provenance.cap_applied ? ` · ${t('notifOps.pvApplied', 'APPLIED')}` : ''}</li>
                    <li>{t('notifOps.pvOverride', 'required override')}: {provenance.required_override_applied ? t('notifOps.pvApplied', 'APPLIED') : '—'}</li>
                    <li>{t('notifOps.pvContact', 'contact')}: {provenance.contact_found ? provenance.destination_masked : t('notifOps.pvNoContact', 'none in scope')}</li>
                    <li>{t('notifOps.pvSuppressed', 'suppressed')}: {provenance.suppressed ? t('notifOps.yes', 'yes') : '—'}</li>
                    <li>{t('notifOps.pvKill', 'kill / circuit')}: {provenance.kill_state} / {provenance.circuit_state}</li>
                    <li><strong>{t('notifOps.pvFinal', 'final')}: {provenance.final_frequency} → {provenance.final_decision}</strong></li>
                  </ul>
                ) : null}
              </div>
            )}
            {cursor && (
              <Button size="sm" variant="outline" className="mt-2" onClick={() => void load(true)} data-testid="preview-more">
                {t('notifOps.more', 'Load more')}
              </Button>
            )}
          </div>
        </ListPageState>
      )}
    </section>
  );
}
