import { useState } from 'react';
import { Copy, Check, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';

interface Props {
  /** The handle/slug to display, e.g. "jan-de-vries". */
  handle: string;
  label?: string;
  className?: string;
}

const HOST = 'padeltrainer.ai';

export function ShareableProfileLink({ handle, label = 'Your share link', className }: Props) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const display = `${HOST}/${handle}`;
  const fullUrl = `https://${display}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      toast({ title: 'Link copied' });
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: 'Could not copy', variant: 'destructive' });
    }
  };

  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ url: fullUrl, title: 'My PadelTrainer profile' });
      } catch {
        /* user cancelled */
      }
    } else {
      copy();
    }
  };

  if (!handle) return null;

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
