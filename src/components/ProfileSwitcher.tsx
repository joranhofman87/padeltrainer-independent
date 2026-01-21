import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Building2, User, ChevronDown, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useAuth } from '@/hooks/useAuth';
import { getUserClubProfiles, type ClubProfile } from '@/lib/club';
import type { Location } from '@/lib/locations';

interface ClubWithLocation extends ClubProfile {
  role: string;
  location: Location;
}

interface ProfileSwitcherProps {
  /** Current context: 'club' when on club pages, 'trainer' when on trainer pages */
  context?: 'club' | 'trainer';
  /** Active club ID (only used in club context) */
  activeClubId?: string;
  /** Callback when club is changed (only used in club context) */
  onClubChange?: (club: ClubWithLocation) => void;
}

export function ProfileSwitcher({ context = 'club', activeClubId, onClubChange }: ProfileSwitcherProps) {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const { user, roles, profile, isClubManager } = useAuth();
  const [clubs, setClubs] = useState<ClubWithLocation[]>([]);
  const [loading, setLoading] = useState(true);

  const isTrainer = roles.includes('trainer');
  const hasMultipleClubs = clubs.length > 1;
  
  // Show switcher if user has multiple roles or multiple clubs
  const showSwitcher = (isTrainer && isClubManager) || hasMultipleClubs;

  useEffect(() => {
    async function fetchClubs() {
      if (!user) return;
      
      try {
        const userClubs = await getUserClubProfiles(user.id);
        setClubs(userClubs);
      } catch (error) {
        console.error('Error fetching clubs:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchClubs();
  }, [user]);

  if (loading || !showSwitcher) {
    return null;
  }

  const activeClub = clubs.find(c => c.id === activeClubId) || clubs[0];
  
  // Display info based on context
  const displayName = context === 'trainer' 
    ? profile?.full_name || t('trainerDashboard')
    : activeClub?.location?.name || t('clubDashboard');
  
  const displayAvatar = context === 'trainer'
    ? profile?.avatar_url
    : activeClub?.logo_url;
  
  const initials = context === 'trainer'
    ? profile?.full_name?.split(' ').map(n => n[0]).join('').toUpperCase() || 'TR'
    : activeClub?.location?.name?.substring(0, 2).toUpperCase() || 'CL';

  const handleSwitchToTrainer = () => {
    navigate('/trainer');
  };

  const handleSwitchToClub = (club?: ClubWithLocation) => {
    if (context === 'club' && club && onClubChange) {
      onClubChange(club);
    } else {
      navigate('/club');
    }
  };

  const handleClubSelect = (club: ClubWithLocation) => {
    if (context === 'club' && onClubChange) {
      onClubChange(club);
    } else {
      // Navigate to club dashboard when switching from trainer context
      navigate('/club');
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="flex items-center gap-2 h-auto py-1.5 px-2">
          <Avatar className="h-7 w-7">
            <AvatarImage src={displayAvatar || undefined} />
            <AvatarFallback className="text-xs bg-primary/10 text-primary">
              {initials}
            </AvatarFallback>
          </Avatar>
          <span className="font-medium text-sm hidden sm:inline max-w-[120px] truncate">
            {displayName}
          </span>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {/* Trainer Section - show when on trainer context or when trainer wants to switch */}
        {isTrainer && context === 'club' && (
          <>
            <DropdownMenuLabel className="flex items-center gap-2">
              <User className="h-4 w-4" />
              {t('switchRole')}
            </DropdownMenuLabel>
            <DropdownMenuItem
              onClick={handleSwitchToTrainer}
              className="flex items-center gap-2 cursor-pointer"
            >
              <Avatar className="h-6 w-6">
                <AvatarImage src={profile?.avatar_url || undefined} />
                <AvatarFallback className="text-xs bg-secondary">
                  {profile?.full_name?.split(' ').map(n => n[0]).join('').toUpperCase() || 'TR'}
                </AvatarFallback>
              </Avatar>
              <span className="flex-1">{t('trainerDashboard')}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}

        {/* Clubs Section */}
        {clubs.length > 0 && (
          <>
            <DropdownMenuLabel className="flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              {t('myClubs')}
            </DropdownMenuLabel>
            {clubs.map((club) => (
              <DropdownMenuItem
                key={club.id}
                onClick={() => handleClubSelect(club)}
                className="flex items-center gap-2 cursor-pointer"
              >
                <Avatar className="h-6 w-6">
                  <AvatarImage src={club.logo_url || undefined} />
                  <AvatarFallback className="text-xs bg-primary/10 text-primary">
                    {club.location?.name?.substring(0, 2).toUpperCase() || 'CL'}
                  </AvatarFallback>
                </Avatar>
                <span className="flex-1 truncate">{club.location?.name}</span>
                {context === 'club' && club.id === activeClubId && (
                  <Check className="h-4 w-4 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </>
        )}

        {/* Switch to Club when in trainer context */}
        {isClubManager && context === 'trainer' && clubs.length === 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              {t('switchRole')}
            </DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => handleSwitchToClub()}
              className="flex items-center gap-2 cursor-pointer"
            >
              <Avatar className="h-6 w-6">
                <AvatarFallback className="text-xs bg-primary/10 text-primary">
                  CL
                </AvatarFallback>
              </Avatar>
              <span className="flex-1">{t('clubDashboard')}</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
