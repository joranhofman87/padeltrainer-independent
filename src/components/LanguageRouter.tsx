import { lazy, Suspense, useEffect } from 'react';
import { Outlet, useParams, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';

const ShortLinkResolver = lazy(() => import('@/pages/ShortLinkResolver'));

// Matches ShortLinkResolver's own loading state, so a cold visit to a shared
// short link shows a spinner instead of a blank page while the chunk loads.
function ShortLinkLoading() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

const SUPPORTED_LANGUAGES = ['en', 'nl'];
const DEFAULT_LANGUAGE = 'en';

export function LanguageRouter() {
  const { lang } = useParams<{ lang: string }>();
  const { i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const isSupportedLang = !!lang && SUPPORTED_LANGUAGES.includes(lang);

  useEffect(() => {
    if (isSupportedLang && i18n.language !== lang) {
      i18n.changeLanguage(lang!);
    }
  }, [isSupportedLang, lang, i18n]);

  // A single top-level segment (e.g. /jan-de-vries) might be a short share-link.
  const isSingleSegment =
    location.pathname.replace(/\/+$/, '').split('/').filter(Boolean).length === 1;

  useEffect(() => {
    // If it's neither a supported language nor a possible handle, redirect
    // to the default language prefix (preserves prior behavior for /xx/foo/bar).
    if (lang && !isSupportedLang && !isSingleSegment) {
      const newPath = `/${DEFAULT_LANGUAGE}${location.pathname.replace(/^\/(en|nl|es|de|fr|it)/, '')}${location.search}`;
      navigate(newPath, { replace: true });
    }
  }, [lang, isSupportedLang, isSingleSegment, location, navigate]);

  if (!isSupportedLang && isSingleSegment && lang) {
    const stored = (() => {
      try { return localStorage.getItem('i18nextLng'); } catch { return null; }
    })();
    const storedLang = stored?.split('-')[0];
    const targetLang =
      storedLang && SUPPORTED_LANGUAGES.includes(storedLang) ? storedLang : DEFAULT_LANGUAGE;
    return (
      <Suspense fallback={<ShortLinkLoading />}>
        <ShortLinkResolver handle={lang} lang={targetLang} />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={null}>
      <Outlet />
    </Suspense>
  );
}

export function RootRedirect() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const stored = (() => {
      try { return localStorage.getItem('i18nextLng'); } catch { return null; }
    })();
    const storedLang = stored?.split('-')[0];
    const browserLang = navigator.language?.split('-')[0] || DEFAULT_LANGUAGE;
    const candidate = (storedLang && SUPPORTED_LANGUAGES.includes(storedLang))
      ? storedLang
      : (SUPPORTED_LANGUAGES.includes(browserLang) ? browserLang : DEFAULT_LANGUAGE);

    const remainingPath = location.pathname === '/' ? '' : location.pathname;
    navigate(`/${candidate}${remainingPath}${location.search}`, { replace: true });
  }, [navigate, location]);

  return null;
}

export { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE };
