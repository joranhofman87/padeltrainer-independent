import { Copy, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Button, type ButtonProps } from '@/components/ui/button';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { cn } from '@/lib/utils';

interface CopyLinkButtonProps {
  /** The URL (or any text) to copy. */
  url: string;
  /** Optional visible label next to the icon. Icon-only when omitted. */
  label?: string;
  /** Toast shown on success; pass null to suppress the toast entirely. Default: 'Link copied'. */
  toastLabel?: string | null;
  /** Toast shown when the copy genuinely fails (rare). Pass a translated string; English fallback. */
  errorLabel?: string;
  className?: string;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  ariaLabel?: string;
}

/**
 * A standalone "copy this link" button built on {@link useCopyToClipboard} — shows a Check state after
 * copying and a toast, with the secure-context + execCommand fallback baked in. Use this for dedicated
 * copy buttons; inside a dropdown menu item, call the hook directly instead (a Button can't nest there).
 */
export function CopyLinkButton({
  url,
  label,
  toastLabel = 'Link copied',
  errorLabel = 'Could not copy',
  className,
  variant = 'outline',
  size = 'sm',
  ariaLabel,
}: CopyLinkButtonProps) {
  const { copied, copy } = useCopyToClipboard();

  const onClick = async () => {
    const ok = await copy(url);
    if (toastLabel !== null) {
      if (ok) toast.success(toastLabel);
      else toast.error(errorLabel);
    }
  };

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={onClick}
      className={cn('gap-1.5', className)}
      aria-label={ariaLabel ?? label ?? 'Copy link'}
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {label}
    </Button>
  );
}
