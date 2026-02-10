import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';

interface GenerateProposalsGuardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onContinue: () => void;
  calendarPath: string;
}

export function GenerateProposalsGuard({ open, onOpenChange, onContinue, calendarPath }: GenerateProposalsGuardProps) {
  const { t } = useTranslation('cycles');
  const navigate = useNavigate();

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('proposals.guard.title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('proposals.guard.description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => navigate(calendarPath)}>
            {t('proposals.guard.goToCalendar')}
          </AlertDialogCancel>
          <AlertDialogAction onClick={onContinue}>
            {t('proposals.guard.continue')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
