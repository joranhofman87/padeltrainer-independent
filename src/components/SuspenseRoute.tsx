import { Suspense, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

function StandalonePageLoader() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center" data-testid="standalone-page-loader">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  );
}

/** Suspense boundary for top-level lazy routes (no role layout parent). */
export function SuspenseRoute({ children }: { children: ReactNode }) {
  return <Suspense fallback={<StandalonePageLoader />}>{children}</Suspense>;
}
