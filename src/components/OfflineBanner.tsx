import { useState, useEffect } from 'react';
import { WifiOff } from 'lucide-react';

/**
 * Shows a banner when the browser is offline.
 *
 * `navigator.onLine` alone is unreliable (it can return false in iframes,
 * VPNs, or after sleep/wake even when the network works). To avoid false
 * positives we additionally verify with a tiny network probe before showing
 * the banner, and re-probe when the browser claims to be back online.
 */
export function OfflineBanner() {
  const [isOffline, setIsOffline] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const verifyOffline = async () => {
      // Try a lightweight no-cors HEAD request against a reliable endpoint.
      // If it resolves we're online, regardless of what navigator.onLine says.
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        await fetch('/favicon.ico', {
          method: 'HEAD',
          cache: 'no-store',
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!cancelled) setIsOffline(false);
      } catch {
        if (!cancelled && !navigator.onLine) setIsOffline(true);
      }
    };

    const goOffline = () => { void verifyOffline(); };
    const goOnline = () => setIsOffline(false);

    // Initial check — only probe if browser claims offline
    if (!navigator.onLine) void verifyOffline();

    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);

    return () => {
      cancelled = true;
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);

  if (!isOffline) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[100] bg-destructive text-destructive-foreground px-4 py-2 text-center text-sm font-medium flex items-center justify-center gap-2">
      <WifiOff className="h-4 w-4" />
      You are offline. Some features may not work until your connection is restored.
    </div>
  );
}
