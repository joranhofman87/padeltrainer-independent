import { useTranslation } from 'react-i18next';
import { RichTextConsent } from '@/components/ui/rich-text-consent';

interface TermsAcceptanceProps {
  terms: string | null;
  loading?: boolean;
  accepted: boolean;
  onAcceptChange: (accepted: boolean) => void;
}

/**
 * Booking general-terms consent gate. A thin wrapper over the reusable {@link RichTextConsent}
 * (box variant) that resolves the booking-terms copy; the shared component owns the box/checkbox
 * markup, the loading state, and the "render nothing when there are no terms" behavior.
 */
export default function TermsAcceptance({ terms, loading, accepted, onAcceptChange }: TermsAcceptanceProps) {
  const { t } = useTranslation('common');

  return (
    <RichTextConsent
      variant="box"
      id="accept-terms"
      content={terms}
      loading={loading}
      loadingLabel={t('loadingTerms', 'Loading terms...')}
      accepted={accepted}
      onAcceptChange={onAcceptChange}
      title={t('generalTerms', 'General Terms')}
      checkboxLabel={t('acceptTerms', 'I have read and accept the general terms and conditions')}
    />
  );
}
