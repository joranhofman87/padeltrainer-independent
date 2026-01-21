import { Helmet } from 'react-helmet-async';
import { useParams } from 'react-router-dom';
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } from '@/components/LanguageRouter';

interface SEOProps {
  title: string;
  description: string;
  image?: string;
  url?: string;
  type?: 'website' | 'article' | 'place';
  structuredData?: object;
  noIndex?: boolean;
}

export function SEO({ 
  title, 
  description, 
  image, 
  url, 
  type = 'website',
  structuredData,
  noIndex = false 
}: SEOProps) {
  const { lang } = useParams<{ lang: string }>();
  const currentLang = lang && SUPPORTED_LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE;
  
  const fullTitle = `${title} | PadelTrainer.ai`;
  const baseUrl = 'https://padeltrainer.ai';
  
  // Get the path without language prefix for hreflang generation
  const pathWithoutLang = url?.replace(/^\/(en|nl)/, '') || '';
  const fullUrl = url ? `${baseUrl}${url}` : `${baseUrl}/${currentLang}`;
  const defaultImage = `${baseUrl}/og-image.png`;

  // Generate alternate URLs for each language
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
        href={`${baseUrl}/nl${pathWithoutLang}`} 
      />
      
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
          {JSON.stringify(structuredData)}
        </script>
      )}
    </Helmet>
  );
}
