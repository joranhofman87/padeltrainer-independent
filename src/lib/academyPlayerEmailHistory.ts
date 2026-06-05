import { buildAcademyInvoiceEditPath } from '@/lib/academyPlayerDetailNavigation';

export type EmailHistorySource = 'campaign' | 'invoice';

export interface AcademyPlayerEmailHistoryItem {
  id: string;
  source: EmailHistorySource;
  title: string;
  subtitle: string | null;
  status: string;
  sortAt: string;
  sent_at: string | null;
  created_at: string;
  href?: string;
}

export interface InvoiceEmailSourceRow {
  id: string;
  invoice_number: string | null;
  sent_at: string | null;
  status: string | null;
  academy_profile_id?: string | null;
}

export interface CampaignEmailSourceRow {
  id: string;
  status: string;
  sent_at: string | null;
  created_at: string;
  subject: string;
}

export function buildInvoiceEmailEvents(
  invoices: InvoiceEmailSourceRow[],
  labels: { sent: string; sentWithNumber: (number: string) => string },
): AcademyPlayerEmailHistoryItem[] {
  return invoices
    .filter((inv) => !!inv.sent_at)
    .map((inv) => {
      const number = inv.invoice_number?.trim();
      return {
        id: `invoice-sent-${inv.id}`,
        source: 'invoice' as const,
        title: number ? labels.sentWithNumber(number) : labels.sent,
        subtitle: number ? null : null,
        status: 'sent',
        sortAt: inv.sent_at!,
        sent_at: inv.sent_at,
        created_at: inv.sent_at!,
        href: buildAcademyInvoiceEditPath(inv.id),
      };
    });
}

export function mapCampaignEmailEvents(
  rows: CampaignEmailSourceRow[],
): AcademyPlayerEmailHistoryItem[] {
  return rows.map((r) => ({
    id: r.id,
    source: 'campaign' as const,
    title: r.subject,
    subtitle: null,
    status: r.status,
    sortAt: r.sent_at || r.created_at,
    sent_at: r.sent_at,
    created_at: r.created_at,
  }));
}

export function mergePlayerEmailHistory(
  campaign: AcademyPlayerEmailHistoryItem[],
  invoice: AcademyPlayerEmailHistoryItem[],
): AcademyPlayerEmailHistoryItem[] {
  return [...campaign, ...invoice].sort(
    (a, b) => new Date(b.sortAt).getTime() - new Date(a.sortAt).getTime(),
  );
}

/** Scope invoice rows to the active academy (defensive; query should already filter). */
export function filterInvoicesForAcademy(
  invoices: InvoiceEmailSourceRow[],
  academyProfileId: string,
): InvoiceEmailSourceRow[] {
  return invoices.filter(
    (inv) => !inv.academy_profile_id || inv.academy_profile_id === academyProfileId,
  );
}
