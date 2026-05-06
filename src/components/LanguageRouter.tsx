import { useEffect } from 'react';
import { Outlet, useParams, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const SUPPORTED_LANGUAGES = ['en', 'nl', 'es', 'de', 'fr', 'it'];
const DEFAULT_LANGUAGE = 'en';

export function LanguageRouter() {
  const { lang } = useParams<{ lang: string }>();
  const { i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (lang && SUPPORTED_LANGUAGES.includes(lang)) {
      if (i18n.language !== lang) {
        i18n.changeLanguage(lang);
      }
    }
  }, [lang, i18n]);

  // If invalid language, redirect to default
  useEffect(() => {
    if (lang && !SUPPORTED_LANGUAGES.includes(lang)) {
      const newPath = `/${DEFAULT_LANGUAGE}${location.pathname.replace(/^\/(en|nl|es|de|fr|it)/, '')}${location.search}`;
      navigate(newPath, { replace: true });
    }
  }, [lang, location, navigate]);

  return <Outlet />;
}

export function RootRedirect() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    // Prefer the user's previously chosen language (persisted by i18next),
    // only fall back to browser language if nothing was stored.
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
