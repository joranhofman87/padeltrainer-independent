import React from 'react';
import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { LocalizedLink } from '@/components/LocalizedLink';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
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

export function ProfileLayout({
  children,
  breadcrumbs,
  headerAction,
  bannerUrl,
  showBackButton = true,
}: ProfileLayoutProps) {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10">
      {/* Banner */}
      {bannerUrl && (
        <div className="w-full h-48 md:h-64 overflow-hidden">
          <img
            src={bannerUrl}
            alt="Profile banner"
            className="w-full h-full object-cover"
            loading="lazy"
          />
        </div>
      )}

      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-3 sm:py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 sm:gap-4 min-w-0 overflow-x-auto">
            {showBackButton && (
              <Button variant="ghost" size="sm" className="shrink-0" onClick={() => navigate(-1)}>
                <ArrowLeft className="h-4 w-4 mr-1 sm:mr-2" />
                <span className="hidden sm:inline">{t('common:breadcrumbs.back', 'Back')}</span>
              </Button>
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
