import { Helmet } from 'react-helmet-async';

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
  const fullTitle = `${title} | PadelTrainer.ai`;
  const baseUrl = 'https://padeltrainer.ai';
  const fullUrl = url ? `${baseUrl}${url}` : baseUrl;
  const defaultImage = `${baseUrl}/og-image.png`;

  return (
    <Helmet>
      {/* Basic Meta Tags */}
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      {noIndex && <meta name="robots" content="noindex, nofollow" />}
      
      {/* Canonical URL */}
      <link rel="canonical" href={fullUrl} />
      
      {/* Open Graph */}
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:type" content={type} />
      <meta property="og:url" content={fullUrl} />
      <meta property="og:image" content={image || defaultImage} />
      <meta property="og:site_name" content="PadelTrainer.ai" />
      <meta property="og:locale" content="nl_NL" />
      <meta property="og:locale:alternate" content="en_US" />
      
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
