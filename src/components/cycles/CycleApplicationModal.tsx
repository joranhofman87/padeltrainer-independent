import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, AlertCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/useAuth';
import { hasPlayerApplied, type Cycle } from '@/lib/cycles';
import { supabase } from '@/integrations/supabase/client';
import CycleApplicationForm from './CycleApplicationForm';
import { format } from 'date-fns';

interface TrainerOption {
  id: string;
  name: string;
}

interface LocationOption {
  id: string;
  name: string;
}

interface CycleApplicationModalProps {
  cycle: Cycle;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trainers?: TrainerOption[];
  locations?: LocationOption[];
}

export default function CycleApplicationModal({
  cycle,
  open,
  onOpenChange,
  trainers = [],
  locations = [],
}: CycleApplicationModalProps) {
  const { t } = useTranslation('cycles');
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [hasApplied, setHasApplied] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(true);

  useEffect(() => {
    async function checkApplication() {
      if (!user || !profile) {
        setCheckingStatus(false);
        return;
      }
      
      try {
        const applied = await hasPlayerApplied(cycle.id, profile.id);
        setHasApplied(applied);
      } catch (error) {
        console.error('Error checking application status:', error);
      } finally {
        setCheckingStatus(false);
      }
    }

    if (open) {
      checkApplication();
    }
  }, [open, user, profile, cycle.id]);

  const handleLoginRedirect = () => {
    // Store the current URL to redirect back after login
    sessionStorage.setItem('redirectAfterLogin', window.location.pathname);
    navigate('/auth');
  };

  const isDeadlinePassed = cycle.enrollment_deadline 
    ? new Date(cycle.enrollment_deadline) < new Date() 
    : false;

  const isCycleClosed = cycle.status !== 'open';

  // Not logged in
  if (!user) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarDays className="h-5 w-5" />
              {t('application.title')}
            </DialogTitle>
            <DialogDescription>
              {t('application.subtitle', { cycleName: cycle.name })}
            </DialogDescription>
          </DialogHeader>
          
          <div className="py-6 text-center space-y-4">
            <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto" />
            <p className="text-muted-foreground">{t('application.loginRequired')}</p>
            <Button onClick={handleLoginRedirect}>
              {t('common:login', 'Log in')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // Already applied
  if (hasApplied && !checkingStatus) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarDays className="h-5 w-5" />
              {t('application.title')}
            </DialogTitle>
          </DialogHeader>
          
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{t('application.alreadyApplied')}</AlertDescription>
          </Alert>
          
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:close', 'Close')}
          </Button>
        </DialogContent>
      </Dialog>
    );
  }

  // Enrollment closed or deadline passed
  if (isCycleClosed || isDeadlinePassed) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarDays className="h-5 w-5" />
              {t('application.title')}
            </DialogTitle>
          </DialogHeader>
          
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {isDeadlinePassed 
                ? t('application.deadlinePassed') 
                : t('application.enrollmentClosed')}
            </AlertDescription>
          </Alert>
          
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:close', 'Close')}
          </Button>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] p-0">
        <DialogHeader className="px-6 pt-6 pb-0">
          <DialogTitle className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5" />
            {t('application.title')}
          </DialogTitle>
          <DialogDescription>
            {t('application.subtitle', { cycleName: cycle.name })}
            {cycle.enrollment_deadline && (
              <span className="block mt-1 text-sm">
                Deadline: {format(new Date(cycle.enrollment_deadline), 'PPP')}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        
        <ScrollArea className="max-h-[calc(90vh-120px)] px-6 pb-6">
          {checkingStatus ? (
            <div className="py-8 space-y-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-2/3" />
              <div className="flex gap-4 pt-4">
                <Skeleton className="h-10 w-24" />
                <Skeleton className="h-10 w-24" />
              </div>
            </div>
          ) : (
            <CycleApplicationForm
              cycle={cycle}
              playerId={profile!.id}
              playerName={profile!.full_name || ''}
              playerEmail={profile!.email || ''}
              playerRating={profile!.skill_rating || undefined}
              playerRatingSystem={profile!.rating_system}
              trainers={trainers}
              locations={locations}
              onSuccess={() => onOpenChange(false)}
              onCancel={() => onOpenChange(false)}
            />
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
