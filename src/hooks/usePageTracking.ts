import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { trackPostHogPageView } from '@/lib/posthog';

export function usePageTracking() {
  const location = useLocation();

  useEffect(() => {
    const path = location.pathname + location.search;
    trackPostHogPageView(path);

    // Also fire GA pageview if available
    if (window.gtag) {
      window.gtag('event', 'page_view', {
        page_path: path,
      });
    }
  }, [location.pathname, location.search]);
}
