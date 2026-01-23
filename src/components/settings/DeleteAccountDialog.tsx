import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { useTranslation } from 'react-i18next';
import { Trash2, AlertTriangle, Loader2 } from 'lucide-react';

interface DeleteAccountDialogProps {
  trigger?: React.ReactNode;
}

export function DeleteAccountDialog({ trigger }: DeleteAccountDialogProps) {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const { session } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const { t } = useTranslation('common');

  const handleDelete = async () => {
    if (confirmText !== 'DELETE') {
      toast({
        title: t('deleteAccount.error'),
        description: t('deleteAccount.confirmTextError', 'Please type DELETE to confirm'),
        variant: 'destructive',
      });
      return;
    }

    setIsDeleting(true);

    try {
      const { data, error } = await supabase.functions.invoke('request-account-deletion', {
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
        },
      });

      if (error) throw error;

      if (data?.success) {
        toast({
          title: t('deleteAccount.success'),
          description: t('deleteAccount.successDescription', 'Your account has been permanently deleted.'),
        });
        
        // Sign out and redirect to home
        await supabase.auth.signOut();
        navigate('/');
      } else {
        throw new Error(data?.error || 'Failed to delete account');
      }
    } catch (error: any) {
      console.error('Delete account error:', error);
      toast({
        title: t('deleteAccount.error'),
        description: error.message || t('deleteAccount.errorDescription', 'Failed to delete your account. Please try again.'),
        variant: 'destructive',
      });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        {trigger || (
          <Button variant="destructive" className="w-full">
            <Trash2 className="h-4 w-4 mr-2" />
            {t('deleteAccount.title')}
          </Button>
        )}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            {t('deleteAccount.title')}
          </AlertDialogTitle>
          <AlertDialogDescription className="space-y-4">
            <p className="font-medium text-foreground">
              {t('deleteAccount.warning')}
            </p>
            <ul className="list-disc list-inside text-sm space-y-1 text-muted-foreground">
              <li>{t('deleteAccount.warningProfile', 'Your profile and personal information')}</li>
              <li>{t('deleteAccount.warningBookings', 'Your booking history')}</li>
              <li>{t('deleteAccount.warningData', 'All associated data and preferences')}</li>
            </ul>
            <div className="pt-4 space-y-2">
              <Label htmlFor="confirm-delete" className="text-sm font-medium">
                {t('deleteAccount.confirmText')}
              </Label>
              <Input
                id="confirm-delete"
                placeholder="DELETE"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value.toUpperCase())}
                className="font-mono"
              />
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>
            {t('cancel')}
          </AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={confirmText !== 'DELETE' || isDeleting}
          >
            {isDeleting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t('deleteAccount.deleting')}
              </>
            ) : (
              <>
                <Trash2 className="h-4 w-4 mr-2" />
                {t('deleteAccount.confirmButton', 'Delete My Account')}
              </>
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
