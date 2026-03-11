import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { trackPostHogPageView } from '@/lib/posthog';

export function usePageTracking() {
  const location = useLocation();

  useEffect(() => {
    const path = location.pathname + location.search;
    trackPostHogPageView(path);
  }, [location.pathname, location.search]);
}
