import { useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/hooks/use-toast';
import { PlayerInvoicesTab } from '@/components/player/PlayerInvoicesTab';
import { AppPage } from '@/components/ui/app-page';
import { PageHeader } from '@/components/ui/page-header';
import {
  markPaidInvoiceClaimToastShown,
  shouldShowPaidInvoiceClaimToast,
} from '@/lib/signupClaimFlow';
import { trackInvoiceClaimLandedOnInvoices } from '@/lib/invoiceClaimTracking';

export default function PlayerInvoicesPage() {
  const { profile, loading } = useAuth();
  const { t } = useTranslation('player');
  const { toast } = useToast();

  useEffect(() => {
    if (loading || !profile?.id) return;

    try {
      trackInvoiceClaimLandedOnInvoices();
    } catch {
      /* analytics must not block invoices page */
    }

    if (!shouldShowPaidInvoiceClaimToast()) return;

    toast({
      title: t('playerInvoices.claimToast.title'),
      description: t('playerInvoices.claimToast.description'),
    });
    markPaidInvoiceClaimToastShown();
  }, [loading, profile?.id, toast, t]);

  if (loading) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <AppPage as="main" data-testid="page-player-invoices">
      <PageHeader
        title={t('invoices.title', 'Invoices')}
        description={t('invoices.description', 'View and download invoices for your training sessions.')}
      />

      {profile?.id ? (
        <PlayerInvoicesTab profileId={profile.id} />
      ) : (
        <p className="text-sm text-muted-foreground">{t('playerInvoices.loadError')}</p>
      )}
    </AppPage>
  );
}
