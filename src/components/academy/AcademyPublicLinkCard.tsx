import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ShareableProfileLink } from '@/components/profile/ShareableProfileLink';
import { getAcademyShortUrl } from '@/lib/domains';
import {
  canShareAcademyPublicly,
  getAcademyPreviewUrl,
  type AcademyShareVisibilityInput,
} from '@/lib/academyVisibility';

type AcademyPublicLinkCardProps = {
  academy: AcademyShareVisibilityInput & { slug: string };
  lang: string;
};

export function AcademyPublicLinkCard({ academy, lang }: AcademyPublicLinkCardProps) {
  const { t } = useTranslation('academy');
  const navigate = useNavigate();

  if (!academy.slug) return null;

  if (canShareAcademyPublicly(academy)) {
    return (
      <div className="mb-4 rounded-lg border bg-card px-3 py-2">
        <ShareableProfileLink
          handle={academy.slug}
          basePath="academies"
          lang={lang}
          shortUrl={getAcademyShortUrl(academy.slug)}
          label={t('dashboard.sharePublicPage', 'Share public page')}
          compact
        />
      </div>
    );
  }

  const previewUrl = getAcademyPreviewUrl(academy.slug, lang);

  return (
    <div className="mb-4 rounded-lg border bg-card px-3 py-3 space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t('dashboard.previewAcademyPage', 'Preview academy page')}</p>
          <p className="text-xs text-muted-foreground">
            {t(
              'dashboard.previewAcademyHint',
              'Only you can see this until your academy is public on a paid plan.',
            )}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => window.open(previewUrl, '_blank', 'noopener,noreferrer')}
        >
          <ExternalLink className="h-4 w-4 mr-2" />
          {t('dashboard.previewAcademyPage', 'Preview academy page')}
        </Button>
      </div>

      <div className="space-y-2 border-t pt-3">
        <p className="text-xs font-medium text-muted-foreground">
          {t('dashboard.sharePublicPageLocked', 'Share public page')}
        </p>
        <div className="flex items-center gap-2 min-w-0 opacity-70">
          <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <Input
            readOnly
            disabled
            value={t(
              'dashboard.sharePublicPageLockedHint',
              'Public academy pages are available after upgrading.',
            )}
            className="text-xs h-8 flex-1 min-w-0 cursor-not-allowed"
          />
        </div>
        <Button
          type="button"
          size="sm"
          className="w-full sm:w-auto"
          onClick={() => navigate('/app/academy/subscription')}
        >
          {t('dashboard.upgradeToShare', 'Upgrade to share publicly')}
        </Button>
      </div>
    </div>
  );
}
