import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { logger } from '@/lib/logger';
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
import CycleApplicationForm from './CycleApplicationForm';
import CycleDetailDisplay from './CycleDetailDisplay';
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
        logger.warn('Error checking application status', { error, component: 'CycleApplicationModal' });
      } finally {
        setCheckingStatus(false);
      }
    }

    if (open) {
      setCheckingStatus(!!user);
      checkApplication();
    }
  }, [open, user, profile, cycle.id]);

  const isDeadlinePassed = cycle.enrollment_deadline 
    ? new Date(cycle.enrollment_deadline) < new Date() 
    : false;

  const isCycleClosed = cycle.status !== 'open';

  // Already applied (only for logged-in users)
  if (hasApplied && !checkingStatus && user) {
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
          {/* Show cycle details */}
          <CycleDetailDisplay cycle={cycle} />
          
          {checkingStatus ? (
            <div className="py-8 space-y-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-2/3" />
            </div>
          ) : user && profile ? (
            <CycleApplicationForm
              cycle={cycle}
              playerId={profile.id}
              playerUserId={user.id}
              playerName={profile.full_name || ''}
              playerEmail={profile.email || ''}
              playerPhone={profile.phone || ''}
              playerRating={profile.skill_rating ?? undefined}
              playerRatingSystem={profile.rating_system || 'knltb'}
              trainers={trainers}
              locations={locations}
              onSuccess={() => onOpenChange(false)}
              onCancel={() => onOpenChange(false)}
            />
          ) : (
            <CycleApplicationForm
              cycle={cycle}
              playerId=""
              playerUserId=""
              playerName=""
              playerEmail=""
              playerPhone=""
              isGuest
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
