import { useParams } from 'react-router-dom';
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } from '@/components/LanguageRouter';

/**
 * Returns a localized path with the current language prefix
 * @param path - The path without language prefix (e.g., '/about')
 * @returns The localized path (e.g., '/nl/about')
 */
export function useLocalizedPath(path: string): string {
  const { lang } = useParams<{ lang: string }>();
  const currentLang = lang && SUPPORTED_LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE;
  
  // Ensure path starts with /
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  
  // Don't double-prefix if path already has language
  if (SUPPORTED_LANGUAGES.some(l => normalizedPath.startsWith(`/${l}/`) || normalizedPath === `/${l}`)) {
    return normalizedPath;
  }
  
  return `/${currentLang}${normalizedPath === '/' ? '' : normalizedPath}`;
}

/**
 * Hook to get a function that localizes paths
 * Useful when you need to localize multiple paths
 */
export function useLocalizedPathFn(): (path: string) => string {
  const { lang } = useParams<{ lang: string }>();
  const currentLang = lang && SUPPORTED_LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE;
  
  return (path: string) => {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    
    if (SUPPORTED_LANGUAGES.some(l => normalizedPath.startsWith(`/${l}/`) || normalizedPath === `/${l}`)) {
      return normalizedPath;
    }
    
    return `/${currentLang}${normalizedPath === '/' ? '' : normalizedPath}`;
  };
}

/**
 * Get the current language from params
 */
export function useCurrentLanguage(): string {
  const { lang } = useParams<{ lang: string }>();
  return lang && SUPPORTED_LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE;
}
