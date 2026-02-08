import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Bell } from 'lucide-react';
import WaitingListForm from './WaitingListForm';
import { OwnerType } from '@/lib/waitingList';
import { getAppUrl } from '@/lib/domains';
import { useNavigate } from 'react-router-dom';

interface WaitingListCardProps {
  ownerType: OwnerType;
  ownerId: string;
  ownerName: string;
}

export default function WaitingListCard({
  ownerType,
  ownerId,
  ownerName,
}: WaitingListCardProps) {
  const { t } = useTranslation('waitingList');
  const { user } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const navigate = useNavigate();

  const handleClick = () => {
    if (!user) {
      navigate(getAppUrl(`/signup/player?redirect=${encodeURIComponent(window.location.pathname)}`));
      return;
    }
    setIsOpen(true);
  };

  return (
    <Card className="border-dashed border-2 bg-muted/30">
      <CardHeader className="text-center pb-2">
        <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-2">
          <Bell className="h-6 w-6 text-primary" />
        </div>
        <CardTitle className="text-lg">{t('noSpotsAvailable')}</CardTitle>
        <CardDescription>{t('getNotified')}</CardDescription>
      </CardHeader>
      <CardContent className="text-center pt-0">
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
          <DialogTrigger asChild>
            <Button onClick={handleClick} className="mt-2">
              {t('joinWaitingList')}
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{t('joinWaitingList')}</DialogTitle>
            </DialogHeader>
            <WaitingListForm
              ownerType={ownerType}
              ownerId={ownerId}
              ownerName={ownerName}
              onSuccess={() => setIsOpen(false)}
            />
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
