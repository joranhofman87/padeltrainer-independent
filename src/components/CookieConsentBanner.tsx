import { useState } from 'react';
import { useCookieConsent, CookieConsent } from '@/contexts/CookieConsentContext';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { useTranslation } from 'react-i18next';
import { Settings } from 'lucide-react';
import { LocalizedLink } from '@/components/LocalizedLink';

export function CookieConsentBanner() {
  const { hasResponded, acceptAll, rejectNonEssential, savePreferences } = useCookieConsent();
  const [showCustomize, setShowCustomize] = useState(false);
  const [customConsent, setCustomConsent] = useState<CookieConsent>({
    necessary: true,
    analytics: false,
    preferences: false,
  });
  const { t } = useTranslation('common');

  // Don't show if user has already responded
  if (hasResponded) return null;

  const handleCustomize = () => {
    setShowCustomize(true);
  };

  const handleSaveCustom = () => {
    savePreferences(customConsent);
    setShowCustomize(false);
  };

  return (
    <>
      {/* Banner */}
      <div className="fixed bottom-0 left-0 right-0 z-50 py-3 px-4 bg-background border-t shadow-lg animate-in slide-in-from-bottom-4">
        <div className="container mx-auto max-w-5xl">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              {t('cookies.description')}{' '}
              <LocalizedLink to="/privacy" className="text-primary hover:underline">
                {t('cookies.privacyLink')}
              </LocalizedLink>
            </p>
            <div className="flex items-center gap-2 flex-shrink-0">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCustomize}
              >
                {t('cookies.customize')}
              </Button>
              <Button
                size="default"
                className="font-semibold px-6"
                onClick={acceptAll}
              >
                {t('cookies.acceptAll')}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Customize Dialog */}
      <Dialog open={showCustomize} onOpenChange={setShowCustomize}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('cookies.title')}</DialogTitle>
            <DialogDescription>
              {t('cookies.description')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* Necessary cookies - always on */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-base">{t('cookies.necessary')}</Label>
                <p className="text-sm text-muted-foreground">
                  {t('cookies.necessaryDesc')}
                </p>
              </div>
              <Switch checked disabled />
            </div>

            {/* Analytics cookies */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-base">{t('cookies.analytics')}</Label>
                <p className="text-sm text-muted-foreground">
                  {t('cookies.analyticsDesc')}
                </p>
              </div>
              <Switch
                checked={customConsent.analytics}
                onCheckedChange={(checked) =>
                  setCustomConsent((prev) => ({ ...prev, analytics: checked }))
                }
              />
            </div>

            {/* Preference cookies */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-base">{t('cookies.preferences')}</Label>
                <p className="text-sm text-muted-foreground">
                  {t('cookies.preferencesDesc')}
                </p>
              </div>
              <Switch
                checked={customConsent.preferences}
                onCheckedChange={(checked) =>
                  setCustomConsent((prev) => ({ ...prev, preferences: checked }))
                }
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCustomize(false)}>
              {t('cancel')}
            </Button>
            <Button onClick={handleSaveCustom}>{t('cookies.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
