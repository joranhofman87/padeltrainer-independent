import { useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Mail } from 'lucide-react';

interface InvoiceEmailDialogProps {
  open: boolean;
  onClose: () => void;
  playerName: string;
  onSubmit: (email: string) => Promise<void>;
}

export function InvoiceEmailDialog({ open, onClose, playerName, onSubmit }: InvoiceEmailDialogProps) {
  const { t } = useTranslation('common');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !email.includes('@')) {
      setError(t('invoiceEmailDialog.invalidEmail'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      await onSubmit(email);
      setEmail('');
      onClose();
    } catch {
      setError(t('invoiceEmailDialog.saveError'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            {t('invoiceEmailDialog.title')}
          </DialogTitle>
          <DialogDescription>
            <Trans
              i18nKey="invoiceEmailDialog.description"
              ns="common"
              values={{ name: playerName }}
              components={{ strong: <strong /> }}
            />
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="player-email">{t('invoiceEmailDialog.label')}</Label>
            <Input
              id="player-email"
              type="email"
              placeholder={t('invoiceEmailDialog.placeholder')}
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(''); }}
              autoFocus
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
              {t('invoiceEmailDialog.cancel')}
            </Button>
            <Button type="submit" disabled={loading || !email}>
              {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Mail className="h-4 w-4 mr-2" />}
              {t('invoiceEmailDialog.saveAndSend')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
