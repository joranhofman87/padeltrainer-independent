import { useState } from 'react';
import { Copy, Check, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { getMarketingUrl, MARKETING_DOMAIN } from '@/lib/domains';
import { cn } from '@/lib/utils';

interface Props {
  /** The handle/slug to display, e.g. "jan-de-vries". */
  handle: string;
  label?: string;
  className?: string;
  /** Optional marketing path prefix, e.g. "academies". When provided, URL becomes `${MARKETING_DOMAIN}/${lang}/${basePath}/${handle}`. */
  basePath?: string;
  /** Language code for marketing URL. Defaults to "nl". */
  lang?: string;
  /** Render in a slim inline row (no helper text, smaller controls). */
  compact?: boolean;
}

const HOST = 'padeltrainer.ai';

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to fallback
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function ShareableProfileLink({
  handle,
  label = 'Your share link',
  className,
  basePath,
  lang = 'nl',
  compact = false,
}: Props) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  if (!handle) return null;

  const fullUrl = basePath
    ? getMarketingUrl(`${basePath}/${handle}`, lang)
    : `https://${HOST}/${handle}`;
  const display = fullUrl.replace(/^https?:\/\//, '');

  const copy = async () => {
    const ok = await copyToClipboard(fullUrl);
    if (ok) {
      setCopied(true);
      toast({ title: 'Link copied' });
      setTimeout(() => setCopied(false), 1500);
    } else {
      toast({ title: 'Could not copy', variant: 'destructive' });
    }
  };

  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ url: fullUrl, title: 'Share link' });
        return;
      } catch {
        /* user cancelled — fall through to copy */
      }
    }
    copy();
  };

  if (compact) {
    return (
      <div className={cn('flex items-center gap-2 min-w-0', className)}>
        <span className="text-xs font-medium text-muted-foreground shrink-0 hidden sm:inline">
          {label}
        </span>
        <Input
          readOnly
          value={display}
          className="font-mono text-xs h-8 flex-1 min-w-0"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button type="button" variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={copy} aria-label="Copy link">
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
        <Button type="button" variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={share} aria-label="Share link">
          <Share2 className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className={className}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="mt-1 flex items-center gap-2">
        <Input readOnly value={display} className="font-mono text-sm" onFocus={(e) => e.currentTarget.select()} />
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={share}>
          <Share2 className="h-4 w-4" />
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Share this link on social media, email signatures or anywhere you want people to find you.
      </p>
    </div>
  );
}
