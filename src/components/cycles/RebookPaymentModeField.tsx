import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import type { RebookPaymentMode } from '@/lib/priorityClaims';
import { getAcademyUpfrontEligibility, type UpfrontEligibility } from '@/lib/rebookPaymentEligibility';

interface Props {
  academyProfileId: string;
  paymentMode: RebookPaymentMode;
  setPaymentMode: (m: RebookPaymentMode) => void;
}

/**
 * "Betaling" payment-mode picker for the rebook wizards. "Pay directly" (upfront)
 * is only selectable when the academy can actually collect payment — Mollie
 * connected (online checkout) OR a complete invoice business profile (invoice +
 * bank transfer). Otherwise it is disabled and prompts the academy to set payment
 * details up first. Shared by both rebook wizards.
 */
export function RebookPaymentModeField({ academyProfileId, paymentMode, setPaymentMode }: Props) {
  const { t } = useTranslation('cycles');
  const [elig, setElig] = useState<UpfrontEligibility | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAcademyUpfrontEligibility(academyProfileId)
      .then((e) => { if (!cancelled) setElig(e); })
      .catch(() => { if (!cancelled) setElig({ canCharge: false, mollieReady: false, invoiceReady: false }); });
    return () => { cancelled = true; };
  }, [academyProfileId]);

  // If "pay directly" was selected but the academy can't charge, fall back to deferred.
  useEffect(() => {
    if (elig && !elig.canCharge && paymentMode === 'upfront') setPaymentMode('deferred_split');
  }, [elig, paymentMode, setPaymentMode]);

  const upfrontDisabled = elig != null && !elig.canCharge;

  return (
    <Card>
      <CardHeader><CardTitle>{t('rebookShared.paymentTitle', 'Betaling')}</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        <Label>{t('bulkCopy.paymentModeLabel', 'How do players pay when they keep their spot?')}</Label>
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="radio"
            className="mt-1"
            checked={paymentMode === 'deferred_split'}
            onChange={() => setPaymentMode('deferred_split')}
          />
          <span>{t('bulkCopy.paymentModeDeferred', 'Invoice at cycle start — the price is split between everyone who joins')}</span>
        </label>
        <label className={`flex items-start gap-2 text-sm ${upfrontDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
          <input
            type="radio"
            className="mt-1"
            checked={paymentMode === 'upfront'}
            disabled={upfrontDisabled}
            onChange={() => setPaymentMode('upfront')}
          />
          <span>{t('bulkCopy.paymentModeUpfront', 'Pay immediately — the player checks out online when they say yes')}</span>
        </label>
        {upfrontDisabled ? (
          <p className="pl-6 text-xs text-destructive">
            {t('rebookShared.upfrontNoPaymentSetup', 'Stel eerst je betaalgegevens in (Mollie of bankgegevens) om direct betalen aan te zetten.')}{' '}
            <Link to="/app/academy/settings" className="font-medium underline">
              {t('rebookShared.upfrontSetupLink', 'Betaalgegevens instellen')}
            </Link>
          </p>
        ) : paymentMode === 'upfront' && elig && !elig.mollieReady && elig.invoiceReady ? (
          <p className="pl-6 text-xs text-muted-foreground">
            {t('rebookShared.upfrontManualHint', 'Spelers betalen direct via een factuur met bankgegevens (Mollie is niet gekoppeld).')}
          </p>
        ) : paymentMode === 'upfront' ? (
          <p className="pl-6 text-xs text-muted-foreground">
            {t('bulkCopy.paymentModeUpfrontHint', 'Requires online payments (Mollie) for the trainer or academy.')}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
