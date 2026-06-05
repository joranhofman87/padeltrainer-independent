import { useParams } from 'react-router-dom';
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } from '@/components/LanguageRouter';

/** App routes live at `/app/*` without a language prefix. */
export function isAppPath(path: string): boolean {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return normalizedPath === '/app' || normalizedPath.startsWith('/app/');
}

/**
 * Localize a path for marketing/public routes. App routes are returned unchanged.
 */
export function localizePathWithLang(path: string, currentLang: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  if (isAppPath(normalizedPath)) {
    return normalizedPath;
  }

  if (SUPPORTED_LANGUAGES.some(l => normalizedPath.startsWith(`/${l}/`) || normalizedPath === `/${l}`)) {
    return normalizedPath;
  }

  return `/${currentLang}${normalizedPath === '/' ? '' : normalizedPath}`;
}

/**
 * Returns a localized path with the current language prefix
 * @param path - The path without language prefix (e.g., '/about')
 * @returns The localized path (e.g., '/nl/about')
 */
export function useLocalizedPath(path: string): string {
  const { lang } = useParams<{ lang: string }>();
  const currentLang = lang && SUPPORTED_LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE;
  return localizePathWithLang(path, currentLang);
}

/**
 * Hook to get a function that localizes paths
 * Useful when you need to localize multiple paths
 */
export function useLocalizedPathFn(): (path: string) => string {
  const { lang } = useParams<{ lang: string }>();
  const currentLang = lang && SUPPORTED_LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE;
  return (path: string) => localizePathWithLang(path, currentLang);
}

/**
 * Get the current language from params
 */
export function useCurrentLanguage(): string {
  const { lang } = useParams<{ lang: string }>();
  return lang && SUPPORTED_LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE;
}
