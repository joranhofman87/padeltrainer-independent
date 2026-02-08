import { Bell, BellOff, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useFollowClub } from '@/hooks/useFollowClub';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

interface ClubFollowButtonProps {
  clubProfileId: string;
  className?: string;
  size?: 'default' | 'sm' | 'lg' | 'icon';
  variant?: 'icon' | 'full';
}

export function ClubFollowButton({ clubProfileId, className, size = 'lg', variant = 'full' }: ClubFollowButtonProps) {
  const { isFollowing, loading, toggleFollow, canFollow } = useFollowClub(clubProfileId);
  const { t } = useTranslation('common');

  if (!canFollow) {
    return null;
  }

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    toggleFollow();
  };

  if (variant === 'icon') {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={isFollowing ? 'default' : 'outline'}
              size="icon"
              className={cn('shrink-0', isFollowing && 'bg-primary text-primary-foreground', className)}
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
              ? t('locations.followingClub', 'Following this club')
              : t('locations.followClub', 'Get notified about updates')}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <Button
      variant={isFollowing ? 'default' : 'outline'}
      size={size}
      className={cn('w-full', isFollowing && 'bg-primary text-primary-foreground', className)}
      onClick={handleClick}
      disabled={loading}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
      ) : isFollowing ? (
        <Bell className="h-4 w-4 mr-2 fill-current" />
      ) : (
        <Bell className="h-4 w-4 mr-2" />
      )}
      {isFollowing
        ? t('locations.followingClub', 'Following')
        : t('locations.followClub', 'Follow Club')}
    </Button>
  );
}
