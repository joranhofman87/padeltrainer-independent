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
import { inviteClubTrainer } from '@/lib/club';
import { sendEmail } from '@/lib/email';
import { getAppUrl } from '@/lib/domains';
import { logger } from '@/lib/logger';

interface InviteClubTrainerDialogProps {
  clubProfileId: string;
  clubName: string;
  locationName: string;
  inviterId: string;
  inviterName: string;
  onInviteSent: () => void;
}

export function InviteClubTrainerDialog({
  clubProfileId,
  clubName,
  locationName,
  inviterId,
  inviterName,
  onInviteSent,
}: InviteClubTrainerDialogProps) {
  const { t } = useTranslation('club');
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
      const result = await inviteClubTrainer(clubProfileId, email, inviterId, message);

      if (!result.success) {
        toast({
          title: t('trainerInvitation.error'),
          description: result.error,
          variant: 'destructive',
        });
        return;
      }

      // Send invitation email
      const inviteLink = getAppUrl(`/club/invitation/${result.invitation?.token}`);
      await sendEmail('club_trainer_invitation', email, {
        clubName,
        locationName,
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
      logger.error('Error sending club trainer invitation', error as Error, { component: 'InviteClubTrainerDialog', clubProfileId, email });
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
