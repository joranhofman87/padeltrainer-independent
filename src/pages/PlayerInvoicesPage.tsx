import { useAuth } from '@/hooks/useAuth';
import { useTranslation } from 'react-i18next';
import { PlayerInvoicesTab } from '@/components/player/PlayerInvoicesTab';

export default function PlayerInvoicesPage() {
  const { profile, loading } = useAuth();
  const { t } = useTranslation('player');

  if (loading) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6" data-testid="page-player-invoices">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">{t('invoices.title', 'Invoices')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('invoices.description', 'View and download invoices for your training sessions.')}
        </p>
      </div>

      {profile?.id ? (
        <PlayerInvoicesTab profileId={profile.id} />
      ) : (
        <p className="text-muted-foreground text-sm">{t('playerInvoices.loadError')}</p>
      )}
    </main>
  );
}
