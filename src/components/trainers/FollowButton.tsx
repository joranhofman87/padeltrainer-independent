import { Bell, BellOff, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useFollowTrainer } from '@/hooks/useFollowTrainer';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

interface FollowButtonProps {
  trainerProfileId: string;
  className?: string;
  size?: 'default' | 'sm' | 'icon';
}

export function FollowButton({ trainerProfileId, className, size = 'icon' }: FollowButtonProps) {
  const { isFollowing, loading, toggleFollow, canFollow } = useFollowTrainer(trainerProfileId);
  const { t } = useTranslation('player');

  if (!canFollow) {
    return null;
  }

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    toggleFollow();
  };

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={isFollowing ? 'default' : 'outline'}
            size={size}
            className={cn(
              'shrink-0',
              isFollowing && 'bg-primary text-primary-foreground',
              className
            )}
            onClick={handleClick}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isFollowing ? (
              <Bell className="h-4 w-4 fill-current" />
            ) : (
              <BellOff className="h-4 w-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {isFollowing
            ? t('trainerProfile.following')
            : t('followingList.notifyAvailability')}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
