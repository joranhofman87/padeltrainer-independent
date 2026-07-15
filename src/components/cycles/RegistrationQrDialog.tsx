import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { QRCodeCanvas, QRCodeSVG } from 'qrcode.react';
import { toast } from 'sonner';
import { Download } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CopyLinkButton } from '@/components/ui/CopyLinkButton';

/**
 * Shows a QR code for a cycle's public registration URL so the academy can put
 * it on printed materials. The QR encodes the same URL as the "Share link"
 * action. Download as PNG (high-res, print-quality) or SVG (vector). The
 * academy logo is excavated into the centre when available (level H keeps it
 * scannable); the logo loads with crossOrigin so the PNG export isn't tainted.
 */
export default function RegistrationQrDialog({
  open,
  onOpenChange,
  url,
  title,
  logoUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url: string;
  title?: string | null;
  logoUrl?: string | null;
}) {
  const { t } = useTranslation('cycles');
  const svgWrapRef = useRef<HTMLDivElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);

  const fileBase = `qr-${(title || 'registratie').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

  const imageSettings = logoUrl
    ? { src: logoUrl, height: 44, width: 44, excavate: true, crossOrigin: 'anonymous' as const }
    : undefined;

  const triggerDownload = (href: string, filename: string) => {
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const downloadPng = () => {
    const canvas = canvasWrapRef.current?.querySelector('canvas');
    if (!canvas) return;
    try {
      triggerDownload(canvas.toDataURL('image/png'), `${fileBase}.png`);
    } catch {
      toast.error(t('qr.downloadError', 'Could not generate the image. Try the SVG instead.'));
    }
  };

  const downloadSvg = () => {
    const svg = svgWrapRef.current?.querySelector('svg');
    if (!svg) return;
    const data = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([data], { type: 'image/svg+xml;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    triggerDownload(objectUrl, `${fileBase}.svg`);
    URL.revokeObjectURL(objectUrl);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('qr.title', 'QR code')}</DialogTitle>
          <DialogDescription>
            {t('qr.scanHint', 'Scan to open the registration form')}
            {title ? ` — ${title}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4">
          <div ref={svgWrapRef} className="rounded-lg border bg-white p-4">
            <QRCodeSVG value={url} size={224} level="H" marginSize={2} imageSettings={imageSettings} />
          </div>

          <p className="w-full break-all text-center text-xs text-muted-foreground">{url}</p>

          <div className="grid w-full grid-cols-2 gap-2">
            <Button variant="outline" onClick={downloadPng} className="gap-1.5">
              <Download className="h-4 w-4" /> {t('qr.png', 'PNG')}
            </Button>
            <Button variant="outline" onClick={downloadSvg} className="gap-1.5">
              <Download className="h-4 w-4" /> {t('qr.svg', 'SVG')}
            </Button>
          </div>
          <CopyLinkButton
            url={url}
            label={t('actions.shareLink', 'Copy link')}
            toastLabel={t('actions.linkCopied')}
            errorLabel={t('actions.linkCopyError', 'Could not copy the link.')}
            variant="ghost"
          />
        </div>

        {/* Off-screen high-res canvas used only for the print-quality PNG export. */}
        <div ref={canvasWrapRef} className="pointer-events-none absolute -z-10 opacity-0" aria-hidden>
          <QRCodeCanvas
            value={url}
            size={1024}
            level="H"
            marginSize={2}
            imageSettings={imageSettings ? { ...imageSettings, height: 200, width: 200 } : undefined}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
