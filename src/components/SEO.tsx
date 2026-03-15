import { Helmet } from 'react-helmet-async';
import { useParams, useLocation } from 'react-router-dom';
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } from '@/components/LanguageRouter';
import { MARKETING_DOMAIN } from '@/lib/domains';

interface SEOProps {
  title: string;
  description: string;
  image?: string;
  url?: string;
  type?: 'website' | 'article' | 'place';
  structuredData?: object | object[];
  noIndex?: boolean;
}

const OG_LOCALE_MAP: Record<string, string> = {
  en: 'en_US', nl: 'nl_NL', es: 'es_ES', de: 'de_DE', fr: 'fr_FR',
};

export function SEO({ 
  title, 
  description, 
  image, 
  url, 
  type = 'website',
  structuredData,
  noIndex = false,
}: SEOProps) {
  const { lang } = useParams<{ lang: string }>();
  const currentLang = lang && SUPPORTED_LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE;
  
  const fullTitle = `${title} | PadelTrainer.ai`;
  
  const baseUrl = MARKETING_DOMAIN;
  
  const pathWithoutLang = url?.replace(/^\/(en|nl|es|de|fr)/, '') || '';
  
  const fullUrl = url 
    ? `${baseUrl}/${currentLang}${pathWithoutLang}` 
    : `${baseUrl}/${currentLang}`;
  
  const defaultImage = `${MARKETING_DOMAIN}/og-image.png`;

  const alternateUrls = SUPPORTED_LANGUAGES.map(langCode => ({
    lang: langCode,
    url: `${baseUrl}/${langCode}${pathWithoutLang}`
  }));

  return (
    <Helmet>
      {/* Basic Meta Tags */}
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      {noIndex && <meta name="robots" content="noindex, nofollow" />}
      
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
      {/* x-default points to Dutch as the primary/default language */}
      <link 
        rel="alternate" 
        hrefLang="x-default" 
        href={`${MARKETING_DOMAIN}/nl${pathWithoutLang}`} 
      />
      
      {/* Open Graph */}
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:type" content={type} />
      <meta property="og:url" content={fullUrl} />
      <meta property="og:image" content={image || defaultImage} />
      <meta property="og:site_name" content="PadelTrainer.ai" />
      <meta property="og:locale" content={OG_LOCALE_MAP[currentLang] || 'en_US'} />
      {SUPPORTED_LANGUAGES.filter(l => l !== currentLang).map(l => (
        <meta key={l} property="og:locale:alternate" content={OG_LOCALE_MAP[l] || 'en_US'} />
      ))}
      
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
