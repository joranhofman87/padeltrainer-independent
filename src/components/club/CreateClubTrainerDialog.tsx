import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UserPlus, Loader2, Copy, Check } from 'lucide-react';
import { logger } from '@/lib/logger';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabaseClient';

interface CreateClubTrainerDialogProps {
  clubProfileId: string;
  locationId: string;
  onTrainerCreated: () => void;
}

export function CreateClubTrainerDialog({
  clubProfileId,
  locationId,
  onTrainerCreated,
}: CreateClubTrainerDialogProps) {
  const { t } = useTranslation('club');
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    temporaryPassword?: string;
    isNewUser: boolean;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !fullName) return;

    setLoading(true);
    setResult(null);

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const response = await supabase.functions.invoke('create-club-trainer', {
        body: { email, fullName, phone, clubProfileId, locationId },
      });

      if (response.error) {
        throw new Error(response.error.message || 'Failed to create trainer');
      }

      const data = response.data;

      if (data.error) {
        throw new Error(data.error);
      }

      setResult({
        temporaryPassword: data.temporaryPassword,
        isNewUser: data.isNewUser,
      });

      toast({
        title: t('createTrainer.success', 'Trainer Created'),
        description: data.isNewUser
          ? t('createTrainer.newUserCreated', 'A new trainer account has been created.')
          : t('createTrainer.existingUserLinked', 'The trainer has been linked to your club.'),
      });

      onTrainerCreated();
    } catch (error) {
      console.error('Error creating trainer:', error);
      toast({
        title: t('createTrainer.error', 'Error'),
        description: String(error),
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (result?.temporaryPassword) {
      await navigator.clipboard.writeText(result.temporaryPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleClose = () => {
    setOpen(false);
    setEmail('');
    setFullName('');
    setPhone('');
    setResult(null);
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => isOpen ? setOpen(true) : handleClose()}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <UserPlus className="h-4 w-4 mr-2" />
          {t('createTrainer.button', 'Create Trainer')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        {!result ? (
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>{t('createTrainer.title', 'Create Trainer Account')}</DialogTitle>
              <DialogDescription>
                {t('createTrainer.description', 'Create a new trainer account or link an existing user to your club.')}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="fullName">{t('createTrainer.fullName', 'Full Name')}</Label>
                <Input
                  id="fullName"
                  type="text"
                  placeholder={t('createTrainer.fullNamePlaceholder', 'John Doe')}
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="email">{t('createTrainer.email', 'Email')}</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder={t('createTrainer.emailPlaceholder', 'trainer@example.com')}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="phone">{t('createTrainer.phone', 'Phone (optional)')}</Label>
                <Input
                  id="phone"
                  type="tel"
                  placeholder={t('createTrainer.phonePlaceholder', '+31 6 12345678')}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={handleClose}>
                {t('common:cancel', 'Cancel')}
              </Button>
              <Button type="submit" disabled={loading || !email || !fullName}>
                {loading ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <UserPlus className="h-4 w-4 mr-2" />
                )}
                {t('createTrainer.create', 'Create Trainer')}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('createTrainer.successTitle', 'Trainer Created!')}</DialogTitle>
              <DialogDescription>
                {result.isNewUser
                  ? t('createTrainer.successNewUser', 'The trainer account has been created. Share the login credentials below.')
                  : t('createTrainer.successExistingUser', 'The existing user has been linked to your club as a trainer.')}
              </DialogDescription>
            </DialogHeader>
            
            {result.temporaryPassword && (
              <div className="py-4">
                <Alert>
                  <AlertTitle className="mb-2">{t('createTrainer.credentials', 'Login Credentials')}</AlertTitle>
                  <AlertDescription className="space-y-2">
                    <p><strong>Email:</strong> {email}</p>
                    <div className="flex items-center gap-2">
                      <strong>Password:</strong>
                      <code className="bg-muted px-2 py-1 rounded text-sm">
                        {result.temporaryPassword}
                      </code>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={handleCopy}
                      >
                        {copied ? (
                          <Check className="h-4 w-4 text-green-500" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                    <p className="text-sm text-muted-foreground mt-2">
                      {t('createTrainer.shareNote', 'Share these credentials securely with the trainer. They should change their password after first login.')}
                    </p>
                  </AlertDescription>
                </Alert>
              </div>
            )}

            <DialogFooter>
              <Button onClick={handleClose}>
                {t('common:done', 'Done')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
