import { useState, useEffect } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Loader2, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface TermsAcceptanceProps {
  terms: string | null;
  loading?: boolean;
  accepted: boolean;
  onAcceptChange: (accepted: boolean) => void;
}

export default function TermsAcceptance({ terms, loading, accepted, onAcceptChange }: TermsAcceptanceProps) {
  const { t } = useTranslation('common');

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('loadingTerms', 'Loading terms...')}
      </div>
    );
  }

  if (!terms) return null;

  return (
    <div className="space-y-3">
      <div className="border rounded-lg p-3 max-h-40 overflow-y-auto bg-muted/30">
        <div className="flex items-center gap-2 text-sm font-medium mb-2">
          <FileText className="h-4 w-4" />
          {t('generalTerms', 'General Terms')}
        </div>
        <div
          className="prose prose-xs dark:prose-invert max-w-none text-xs"
          dangerouslySetInnerHTML={{ __html: terms }}
        />
      </div>
      <div className="flex items-start space-x-3">
        <Checkbox
          id="accept-terms"
          checked={accepted}
          onCheckedChange={(checked) => onAcceptChange(checked === true)}
        />
        <Label htmlFor="accept-terms" className="font-normal text-sm leading-relaxed cursor-pointer">
          {t('acceptTerms', 'I have read and accept the general terms and conditions')}
        </Label>
      </div>
    </div>
  );
}
