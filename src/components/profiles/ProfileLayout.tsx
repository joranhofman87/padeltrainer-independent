import React, { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { LocalizedLink } from '@/components/LocalizedLink';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';

interface BreadcrumbItem {
  label: string;
  path?: string;
}

interface ProfileLayoutProps {
  children: React.ReactNode;
  breadcrumbs?: BreadcrumbItem[];
  headerAction?: React.ReactNode;
  bannerUrl?: string | null;
  showBackButton?: boolean;
}

// Supabase storage serves files from the avatars bucket as
// `application/octet-stream`. Browsers content-sniff raster images (PNG/JPG)
// and render them anyway, but they deliberately do NOT sniff SVG (XSS safety),
// so an SVG banner shows up blank in an <img>. For SVG banners we fetch the
// markup and re-wrap it as a correctly-typed blob URL so it renders regardless
// of the stored content-type. Raster banners pass straight through.
function BannerImage({ url }: { url: string }) {
  const [src, setSrc] = useState(url);

  useEffect(() => {
    if (!/\.svg(\?|#|$)/i.test(url)) {
      setSrc(url);
      return;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
        setSrc(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setSrc(url); // fall back to the raw URL
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  return (
    <img
      src={src}
      alt="Profile banner"
      className="w-full h-full object-cover"
      loading="lazy"
    />
  );
}

export function ProfileLayout({
  children,
  breadcrumbs,
  headerAction,
  bannerUrl,
  showBackButton = true,
}: ProfileLayoutProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <div className="min-h-screen bg-background">
      {/* Banner */}
      {bannerUrl && (
        <div className="w-full h-32 sm:h-48 md:h-64 overflow-hidden">
          <BannerImage url={bannerUrl} />
        </div>
      )}

      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-3 sm:py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 sm:gap-4 min-w-0 overflow-x-auto">
            {showBackButton && (
              <Button variant="ghost" size="sm" className="shrink-0" onClick={() => navigate(-1)} aria-label={t('common:breadcrumbs.back', 'Back')}>
                <ArrowLeft className="h-4 w-4 mr-1 sm:mr-2" />
                <span className="hidden sm:inline">{t('common:breadcrumbs.back', 'Back')}</span>
              </Button>
            )}
            {breadcrumbs && breadcrumbs.length > 0 && (
              <Breadcrumb className="min-w-0">
                <BreadcrumbList className="flex-nowrap">
                  {breadcrumbs.map((crumb, index) => {
                    // On mobile, hide middle breadcrumb items (keep first and last two)
                    const isMiddle = breadcrumbs.length > 3 && index > 0 && index < breadcrumbs.length - 2;
                    return (
                      <React.Fragment key={index}>
                        {index > 0 && <BreadcrumbSeparator className={isMiddle ? 'hidden sm:flex' : ''} />}
                        <BreadcrumbItem className={isMiddle ? 'hidden sm:flex' : ''}>
                          {crumb.path ? (
                            <BreadcrumbLink asChild>
                              <LocalizedLink to={crumb.path}>{crumb.label}</LocalizedLink>
                            </BreadcrumbLink>
                          ) : (
                            <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                          )}
                        </BreadcrumbItem>
                      </React.Fragment>
                    );
                  })}
                </BreadcrumbList>
              </Breadcrumb>
            )}
          </div>
          {headerAction}
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-5xl">
        {children}
      </main>
    </div>
  );
}

interface ProfileContentGridProps {
  children: React.ReactNode;
}

export function ProfileContentGrid({ children }: ProfileContentGridProps) {
  return (
    <div className="grid lg:grid-cols-3 gap-6">
      {children}
    </div>
  );
}

interface ProfileMainColumnProps {
  children: React.ReactNode;
}

export function ProfileMainColumn({ children }: ProfileMainColumnProps) {
  return <div className="lg:col-span-2 space-y-6">{children}</div>;
}

interface ProfileSidebarColumnProps {
  children: React.ReactNode;
}

export function ProfileSidebarColumn({ children }: ProfileSidebarColumnProps) {
  return <div className="space-y-6">{children}</div>;
}

interface ProfileFullWidthSectionProps {
  children: React.ReactNode;
}

export function ProfileFullWidthSection({ children }: ProfileFullWidthSectionProps) {
  return <div className="mt-8">{children}</div>;
}
