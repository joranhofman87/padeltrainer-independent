import { Helmet } from 'react-helmet-async';
import { useParams, useLocation } from 'react-router-dom';
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } from '@/components/LanguageRouter';
import { MARKETING_DOMAIN, APP_DOMAIN, isInDevelopment } from '@/lib/domains';

interface SEOProps {
  title: string;
  description: string;
  image?: string;
  url?: string;
  type?: 'website' | 'article' | 'place';
  structuredData?: object | object[];
  noIndex?: boolean;
  /** Set to true for app pages (served from app.padeltrainer.ai) */
  isAppPage?: boolean;
}

export function SEO({ 
  title, 
  description, 
  image, 
  url, 
  type = 'website',
  structuredData,
  noIndex = false,
  isAppPage = false
}: SEOProps) {
  const { lang } = useParams<{ lang: string }>();
  const location = useLocation();
  const currentLang = lang && SUPPORTED_LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE;
  
  const fullTitle = `${title} | PadelTrainer.ai`;
  
  // Determine base URL based on page type
  const baseUrl = isAppPage ? APP_DOMAIN : MARKETING_DOMAIN;
  
  // Get the path without language prefix for hreflang generation
  const pathWithoutLang = url?.replace(/^\/(en|nl)/, '') || '';
  
  // For app pages, use the path directly without language prefix
  // For marketing pages, include the language prefix
  const fullUrl = isAppPage 
    ? `${baseUrl}${location.pathname}` 
    : url 
      ? `${baseUrl}/${currentLang}${pathWithoutLang}` 
      : `${baseUrl}/${currentLang}`;
  
  const defaultImage = `${MARKETING_DOMAIN}/og-image.png`;

  // Generate alternate URLs for each language (only for marketing pages)
  const alternateUrls = isAppPage ? [] : SUPPORTED_LANGUAGES.map(langCode => ({
    lang: langCode,
    url: `${baseUrl}/${langCode}${pathWithoutLang}`
  }));

  // App pages should not be indexed
  const shouldNoIndex = noIndex || isAppPage;

  return (
    <Helmet>
      {/* Basic Meta Tags */}
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      {shouldNoIndex && <meta name="robots" content="noindex, nofollow" />}
      
      {/* Language */}
      <html lang={currentLang} />
      
      {/* Canonical URL */}
      <link rel="canonical" href={fullUrl} />
      
      {/* Hreflang tags for multilingual SEO (marketing pages only) */}
      {!isAppPage && alternateUrls.map(({ lang: langCode, url: altUrl }) => (
        <link 
          key={langCode}
          rel="alternate" 
          hrefLang={langCode} 
          href={altUrl} 
        />
      ))}
      {/* x-default points to Dutch as the primary/default language */}
      {!isAppPage && (
        <link 
          rel="alternate" 
          hrefLang="x-default" 
          href={`${MARKETING_DOMAIN}/nl${pathWithoutLang}`} 
        />
      )}
      
      {/* Open Graph */}
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:type" content={type} />
      <meta property="og:url" content={fullUrl} />
      <meta property="og:image" content={image || defaultImage} />
      <meta property="og:site_name" content="PadelTrainer.ai" />
      <meta property="og:locale" content={currentLang === 'nl' ? 'nl_NL' : 'en_US'} />
      <meta property="og:locale:alternate" content={currentLang === 'nl' ? 'en_US' : 'nl_NL'} />
      
      {/* Twitter Card */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={image || defaultImage} />
      
      {/* Structured Data */}
      {structuredData && (
        <script type="application/ld+json">
          {JSON.stringify(Array.isArray(structuredData) ? structuredData : [structuredData])}
        </script>
      )}
    </Helmet>
  );
}
