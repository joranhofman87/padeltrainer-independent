import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mail, Send, Loader2 } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { inviteAcademyTrainer } from '@/lib/academy';
import { sendEmail } from '@/lib/email';
import { getAppUrl } from '@/lib/domains';

interface InviteAcademyTrainerDialogProps {
  academyProfileId: string;
  academyName: string;
  inviterId: string;
  inviterName: string;
  onInviteSent: () => void;
}

export function InviteAcademyTrainerDialog({
  academyProfileId,
  academyName,
  inviterId,
  inviterName,
  onInviteSent,
}: InviteAcademyTrainerDialogProps) {
  const { t } = useTranslation('academy');
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;

    setLoading(true);
    try {
      const result = await inviteAcademyTrainer(
        academyProfileId,
        email,
        inviterId,
        message
      );

      if (!result.success) {
        toast({
          title: t('trainerInvitation.error'),
          description: result.error,
          variant: 'destructive',
        });
        return;
      }

      // Send invitation email
      const inviteLink = getAppUrl(`/academy/invitation/${result.invitation?.token}`);
      await sendEmail('academy_trainer_invitation', email, {
        academyName,
        inviterName,
        inviteMessage: message,
        inviteLink,
      });

      toast({
        title: t('trainerInvitation.sent'),
        description: t('trainerInvitation.sentDescription'),
      });

      setEmail('');
      setMessage('');
      setOpen(false);
      onInviteSent();
    } catch (error) {
      console.error('Error sending invitation:', error);
      toast({
        title: t('trainerInvitation.error'),
        description: String(error),
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Mail className="h-4 w-4 mr-2" />
          {t('trainerInvitation.invite')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('trainerInvitation.invite')}</DialogTitle>
            <DialogDescription>
              {t('trainerInvitation.inviteDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="email">{t('trainerInvitation.email')}</Label>
              <Input
                id="email"
                type="email"
                placeholder={t('trainerInvitation.emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="message">{t('trainerInvitation.message')}</Label>
              <Textarea
                id="message"
                placeholder={t('trainerInvitation.messagePlaceholder')}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" disabled={loading || !email}>
              {loading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Send className="h-4 w-4 mr-2" />
              )}
              {t('trainerInvitation.send')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}