import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface EditorLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-filled when editing an existing link. */
  initialUrl?: string;
  /** When provided, shows a "Remove link" action (editing an existing link). */
  onRemove?: () => void;
  onSubmit: (url: string) => void;
}

/** Styled replacement for the editors' window.prompt() link flow. */
export function EditorLinkDialog({
  open,
  onOpenChange,
  initialUrl = '',
  onRemove,
  onSubmit,
}: EditorLinkDialogProps) {
  const { t } = useTranslation('common');
  const [url, setUrl] = useState(initialUrl);

  useEffect(() => {
    if (open) setUrl(initialUrl);
  }, [open, initialUrl]);

  const submit = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('editorLink.title', 'Add link')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="editor-link-url">{t('editorLink.urlLabel', 'URL')}</Label>
          <Input
            id="editor-link-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
          />
        </div>
        <DialogFooter>
          {onRemove && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onRemove();
                onOpenChange(false);
              }}
            >
              {t('editorLink.remove', 'Remove link')}
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel', 'Cancel')}
          </Button>
          <Button type="button" onClick={submit} disabled={!url.trim()}>
            {t('editorLink.apply', 'Apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
