import { useEffect } from 'react';
import { Outlet, useParams, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const SUPPORTED_LANGUAGES = ['en', 'nl', 'es', 'de', 'fr'];
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
      const newPath = `/${DEFAULT_LANGUAGE}${location.pathname}${location.search}`;
      navigate(newPath, { replace: true });
    }
  }, [lang, location, navigate]);

  return <Outlet />;
}

export function RootRedirect() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    // Detect browser language preference
    const browserLang = navigator.language?.split('-')[0] || DEFAULT_LANGUAGE;
    const targetLang = SUPPORTED_LANGUAGES.includes(browserLang) ? browserLang : DEFAULT_LANGUAGE;
    
    // Preserve any path after root if someone navigates to old URLs
    const remainingPath = location.pathname === '/' ? '' : location.pathname;
    navigate(`/${targetLang}${remainingPath}${location.search}`, { replace: true });
  }, [navigate, location]);

  return null;
}

export { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE };
