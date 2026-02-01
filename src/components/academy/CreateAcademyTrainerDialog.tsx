import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UserPlus, Loader2, Copy, Check } from 'lucide-react';
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
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';

interface CreateAcademyTrainerDialogProps {
  academyProfileId: string;
  onTrainerCreated: () => void;
}

interface CreationResult {
  success: boolean;
  trainerId?: string;
  temporaryPassword?: string | null;
  isNewUser?: boolean;
}

export function CreateAcademyTrainerDialog({
  academyProfileId,
  onTrainerCreated,
}: CreateAcademyTrainerDialogProps) {
  const { t } = useTranslation('academy');
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  
  const [result, setResult] = useState<CreationResult | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!email || !fullName) {
      toast({
        title: t('common.error'),
        description: 'Name and email are required',
        variant: 'destructive',
      });
      return;
    }

    setLoading(true);

    try {
      const { data, error } = await supabase.functions.invoke('create-academy-trainer', {
        body: {
          email,
          fullName,
          phone,
          academyProfileId,
        },
      });

      if (error) {
        throw new Error(error.message);
      }

      if (data?.error) {
        throw new Error(data.error);
      }

      setResult({
        success: true,
        trainerId: data.trainerId,
        temporaryPassword: data.temporaryPassword,
        isNewUser: data.isNewUser,
      });

      toast({
        title: t('trainers.trainerCreated'),
        description: data.isNewUser 
          ? t('trainers.newUserCredentials')
          : t('trainers.existingUserLinked'),
      });

      onTrainerCreated();
    } catch (error: any) {
      console.error('Error creating trainer:', error);
      toast({
        title: t('common.error'),
        description: error.message || 'Failed to create trainer',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleCopyPassword = async () => {
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
    setCopied(false);
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => isOpen ? setOpen(true) : handleClose()}>
      <DialogTrigger asChild>
        <Button>
          <UserPlus className="h-4 w-4 mr-2" />
          {t('trainers.createTrainer')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        {result?.success ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-green-600">
                <Check className="h-5 w-5" />
                {t('trainers.trainerCreated')}
              </DialogTitle>
              <DialogDescription>
                {result.isNewUser
                  ? t('trainers.newUserCredentials')
                  : t('trainers.existingUserLinked')}
              </DialogDescription>
            </DialogHeader>
            
            {result.isNewUser && result.temporaryPassword && (
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label>Email</Label>
                  <div className="p-2 bg-muted rounded-md text-sm">{email}</div>
                </div>
                <div className="space-y-2">
                  <Label>Temporary Password</Label>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 p-2 bg-muted rounded-md font-mono text-sm">
                      {result.temporaryPassword}
                    </div>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={handleCopyPassword}
                    >
                      {copied ? (
                        <Check className="h-4 w-4 text-green-600" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Share these credentials securely with the trainer.
                  </p>
                </div>
              </div>
            )}
            
            <DialogFooter>
              <Button onClick={handleClose}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>{t('trainers.createTrainer')}</DialogTitle>
              <DialogDescription>
                {t('trainers.createTrainerDescription')}
              </DialogDescription>
            </DialogHeader>
            
            <div className="grid gap-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="fullName">Full Name *</Label>
                <Input
                  id="fullName"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="John Doe"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email *</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="trainer@example.com"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone">Phone (optional)</Label>
                <Input
                  id="phone"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+31 6 12345678"
                />
              </div>
            </div>
            
            <DialogFooter>
              <Button type="button" variant="outline" onClick={handleClose}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={loading}>
                {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {t('trainers.createTrainer')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
