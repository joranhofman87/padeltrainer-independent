import { Helmet } from 'react-helmet-async';
import { useParams } from 'react-router-dom';
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } from '@/components/LanguageRouter';
import { MARKETING_DOMAIN } from '@/lib/domains';
import type { Translation } from '@/lib/translations';

interface SEOProps {
  title: string;
  description: string;
  image?: string;
  url?: string;
  type?: 'website' | 'article' | 'place';
  structuredData?: object | object[];
  noIndex?: boolean;
  /** Translated slugs from Sanity — when provided, hreflang uses actual translated URLs */
  translations?: Translation[];
  /** URL path prefix for translated content, e.g. 'blog', 'padel-rules' */
  pathPrefix?: string;
  /** ISO date string for article:published_time OG tag */
  publishedTime?: string;
  /** ISO date string for article:modified_time OG tag */
  modifiedTime?: string;
  /** Author name for article:author OG tag */
  author?: string;
}

const OG_LOCALE_MAP: Record<string, string> = {
  en: 'en_US', nl: 'nl_NL', es: 'es_ES', de: 'de_DE', fr: 'fr_FR', it: 'it_IT',
};

export function SEO({ 
  title, 
  description, 
  image, 
  url, 
  type = 'website',
  structuredData,
  noIndex = false,
  translations,
  pathPrefix,
  publishedTime,
  modifiedTime,
  author,
}: SEOProps) {
  const { lang } = useParams<{ lang: string }>();
  const currentLang = lang && SUPPORTED_LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE;
  
  const fullTitle = `${title} | PadelTrainer.ai`;
  
  const baseUrl = MARKETING_DOMAIN;
  
  const pathWithoutLang = url?.replace(/^\/(en|nl|es|de|fr|it)/, '') || '';
  
  // Canonical normalization: strip trailing slash (except root), collapse double slashes
  const normalizePath = (p: string) => {
    if (!p || p === '/') return '';
    const collapsed = p.replace(/\/{2,}/g, '/');
    return collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
  };
  const canonicalPath = normalizePath(pathWithoutLang);

  const fullUrl = `${baseUrl}/${currentLang}${canonicalPath}`;

  const defaultImage = `${MARKETING_DOMAIN}/og-image.png`;

  // If we have CMS translations with actual slugs, use those for hreflang
  const hasTranslatedSlugs = translations && translations.length > 0 && pathPrefix;

  const alternateUrls = hasTranslatedSlugs
    ? translations.map(t => ({
        lang: t.language,
        url: `${baseUrl}/${t.language}/${pathPrefix}/${t.slug}`
      }))
    : SUPPORTED_LANGUAGES.map(langCode => ({
        lang: langCode,
        url: `${baseUrl}/${langCode}${canonicalPath}`
      }));

  // x-default points at the English version (global default).
  // Prior behaviour pointed at the unprefixed URL which 301s to NL — wrong default for the global market.
  const xDefaultUrl = hasTranslatedSlugs
    ? (() => {
        const enTranslation = translations.find(t => t.language === 'en');
        return enTranslation
          ? `${baseUrl}/en/${pathPrefix}/${enTranslation.slug}`
          : `${baseUrl}/en${canonicalPath}`;
      })()
    : `${baseUrl}/en${canonicalPath}`;

  // Optional search-engine verification (set via Vite env vars in deployment).
  const gscToken = (import.meta as any).env?.VITE_GOOGLE_SITE_VERIFICATION as string | undefined;
  const bingToken = (import.meta as any).env?.VITE_BING_SITE_VERIFICATION as string | undefined;

  return (
    <Helmet>
      {/* Basic Meta Tags */}
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      {noIndex && <meta name="robots" content="noindex, nofollow" />}
      {gscToken && <meta name="google-site-verification" content={gscToken} />}
      {bingToken && <meta name="msvalidate.01" content={bingToken} />}
      
      {/* Language */}
      <html lang={currentLang} />
      
      {/* Canonical URL */}
      <link rel="canonical" href={fullUrl} />
      
      {/* Hreflang tags for multilingual SEO */}
      {alternateUrls.map(({ lang: langCode, url: altUrl }) => (
        <link 
          key={langCode}
          rel="alternate" 
          hrefLang={langCode} 
          href={altUrl} 
        />
      ))}
      {/* x-default points at the English locale (global default) */}
      <link 
        rel="alternate" 
        hrefLang="x-default" 
        href={xDefaultUrl} 
      />
      
      {/* Open Graph */}
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:type" content={type} />
      <meta property="og:url" content={fullUrl} />
      <meta property="og:image" content={image || defaultImage} />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta property="og:image:type" content="image/png" />
      <meta property="og:image:alt" content={title} />
      <meta property="og:site_name" content="PadelTrainer.ai" />
      <meta property="og:locale" content={OG_LOCALE_MAP[currentLang] || 'en_US'} />
      {SUPPORTED_LANGUAGES.filter(l => l !== currentLang).map(l => (
        <meta key={l} property="og:locale:alternate" content={OG_LOCALE_MAP[l] || 'en_US'} />
      ))}
      
      {/* Article-specific OG tags */}
      {type === 'article' && publishedTime && (
        <meta property="article:published_time" content={publishedTime} />
      )}
      {type === 'article' && modifiedTime && (
        <meta property="article:modified_time" content={modifiedTime} />
      )}
      {type === 'article' && author && (
        <meta property="article:author" content={author} />
      )}
      
      {/* Twitter Card */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={image || defaultImage} />
      <meta name="twitter:image:alt" content={title} />
      
      {/* Structured Data */}
      {structuredData && (
        <script type="application/ld+json">
          {JSON.stringify(Array.isArray(structuredData) ? structuredData : [structuredData])}
        </script>
      )}
    </Helmet>
  );
}
