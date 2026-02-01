/**
 * Hook to detect whether we're on the marketing site or app subdomain.
 * 
 * Production domains:
 * - padeltrainer.ai (marketing)
 * - app.padeltrainer.ai (app)
 * 
 * Development:
 * - localhost defaults to marketing
 * - localhost?app=true forces app mode
 */
export function useHostname() {
  const hostname = window.location.hostname;
  
  // Production detection
  const isAppDomain = hostname === 'app.padeltrainer.ai';
  const isMarketingDomain = hostname === 'padeltrainer.ai' || 
                            hostname === 'www.padeltrainer.ai';
  
  // Development: allow override via query param or default to marketing
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
  const isLovablePreview = hostname.includes('.lovable.app');
  const searchParams = new URLSearchParams(window.location.search);
  const forceApp = searchParams.get('app') === 'true';
  
  // In development/preview: use query param to switch between modes
  // Default to showing all routes (combined mode) for easier testing
  const isDevelopment = isLocalhost || isLovablePreview;
  
  return {
    isAppDomain: isAppDomain || (isDevelopment && forceApp),
    isMarketingDomain: isMarketingDomain || (isDevelopment && !forceApp),
    isDevelopment,
    hostname,
  };
}

/**
 * Non-hook version for use outside of React components.
 * Returns the same values as useHostname but can be called anywhere.
 */
export function getHostnameInfo() {
  const hostname = window.location.hostname;
  
  const isAppDomain = hostname === 'app.padeltrainer.ai';
  const isMarketingDomain = hostname === 'padeltrainer.ai' || 
                            hostname === 'www.padeltrainer.ai';
  
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
  const isLovablePreview = hostname.includes('.lovable.app');
  const searchParams = new URLSearchParams(window.location.search);
  const forceApp = searchParams.get('app') === 'true';
  
  const isDevelopment = isLocalhost || isLovablePreview;
  
  return {
    isAppDomain: isAppDomain || (isDevelopment && forceApp),
    isMarketingDomain: isMarketingDomain || (isDevelopment && !forceApp),
    isDevelopment,
    hostname,
  };
}
