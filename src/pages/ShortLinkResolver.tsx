import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import NotFound from '@/pages/NotFound';
import { Loader2 } from 'lucide-react';

interface Props {
  /** Optional pre-resolved handle (e.g. when invoked from a wrapper). */
  handle?: string;
  /** Language prefix to apply to the redirect target. */
  lang?: string;
}

type ResolveResult =
  | { owner_type: 'trainer' | 'academy'; slug: string }
  | null;

/**
 * Resolves a short URL like padeltrainer.ai/<handle> to the canonical
 * trainer or academy public profile page.
 */
export default function ShortLinkResolver({ handle: handleProp, lang = 'en' }: Props) {
  const params = useParams<{ handle?: string }>();
  const handle = (handleProp ?? params.handle ?? '').trim();
  const [target, setTarget] = useState<ResolveResult | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    if (!handle) {
      setTarget(null);
      return;
    }
    supabase
      .rpc('resolve_public_handle', { _handle: handle })
      .then(({ data }) => {
        if (cancelled) return;
        setTarget((data as ResolveResult) ?? null);
      })
      .catch(() => {
        if (!cancelled) setTarget(null);
      });
    return () => {
      cancelled = true;
    };
  }, [handle]);

  if (target === undefined) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!target) {
    return <NotFound />;
  }

  const path =
    target.owner_type === 'trainer'
      ? `/${lang}/trainer/${target.slug}`
      : `/${lang}/academies/${target.slug}`;

  return <Navigate to={path} replace />;
}
