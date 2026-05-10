import { lazy, Suspense, useEffect } from 'react';
import { Outlet, useParams, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const ShortLinkResolver = lazy(() => import('@/pages/ShortLinkResolver'));

const SUPPORTED_LANGUAGES = ['en', 'nl', 'es', 'de', 'fr', 'it'];
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
      <Suspense fallback={null}>
        <ShortLinkResolver handle={lang} lang={targetLang} />
      </Suspense>
    );
  }

  return <Outlet />;
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
