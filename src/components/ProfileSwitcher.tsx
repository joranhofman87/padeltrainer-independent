import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Building2, User, ChevronDown, Check, GraduationCap } from 'lucide-react';
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
import { getUserAcademyProfiles, type AcademyProfile } from '@/lib/academy';
import type { Location } from '@/lib/locations';
import { logger } from '@/lib/logger';

interface ClubWithLocation extends ClubProfile {
  role: string;
  location: Location;
}

interface AcademyWithRole extends AcademyProfile {
  role: string;
}

interface ProfileSwitcherProps {
  /** Current context: 'club' when on club pages, 'trainer' when on trainer pages, 'player' when on player pages, 'academy' when on academy pages */
  context?: 'club' | 'trainer' | 'player' | 'academy';
  /** Active club ID (only used in club context) */
  activeClubId?: string;
  /** Active academy ID (only used in academy context) */
  activeAcademyId?: string;
  /** Callback when club is changed (only used in club context) */
  onClubChange?: (club: ClubWithLocation) => void;
  /** Callback when academy is changed (only used in academy context) */
  onAcademyChange?: (academy: AcademyWithRole) => void;
  /** Whether the sidebar is collapsed (icon-only mode) */
  collapsed?: boolean;
}

export function ProfileSwitcher({ 
  context = 'club', 
  activeClubId, 
  activeAcademyId,
  onClubChange,
  onAcademyChange,
  collapsed = false,
}: ProfileSwitcherProps) {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const { user, roles, profile, isClubManager, isAcademyManager } = useAuth();
  const [clubs, setClubs] = useState<ClubWithLocation[]>([]);
  const [academies, setAcademies] = useState<AcademyWithRole[]>([]);
  const [loading, setLoading] = useState(true);

  const isTrainer = roles.includes('trainer');
  const hasMultipleClubs = clubs.length > 1;
  const hasMultipleAcademies = academies.length > 1;
  
  // Show switcher if user has multiple roles, clubs, or academies
  const showSwitcher = 
    (isTrainer && (isClubManager || isAcademyManager)) ||
    hasMultipleClubs ||
    hasMultipleAcademies ||
    (isClubManager && isAcademyManager) ||
    (clubs.length > 0 && academies.length > 0);

  useEffect(() => {
    async function fetchData() {
      if (!user) return;
      
      try {
        const [userClubs, userAcademies] = await Promise.all([
          getUserClubProfiles(user.id),
          getUserAcademyProfiles(user.id),
        ]);
        setClubs(userClubs);
        setAcademies(userAcademies);
      } catch (error) {
        logger.error('Error fetching profiles', error as Error, { component: 'ProfileSwitcher' });
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [user]);

  if (loading || !showSwitcher) {
    return null;
  }

  const activeClub = clubs.find(c => c.id === activeClubId) || clubs[0];
  const activeAcademy = academies.find(a => a.id === activeAcademyId) || academies[0];
  
  // Display info based on context
  const displayName = context === 'trainer' 
    ? profile?.full_name || t('trainerDashboard')
    : context === 'player'
    ? profile?.full_name || t('playerDashboard')
    : context === 'academy'
    ? activeAcademy?.name || t('academyDashboard')
    : activeClub?.location?.name || t('clubDashboard');
  
  const displayAvatar = context === 'trainer' || context === 'player'
    ? profile?.avatar_url
    : context === 'academy'
    ? activeAcademy?.logo_url
    : activeClub?.logo_url;
  
  const initials = context === 'trainer'
    ? profile?.full_name?.split(' ').map(n => n[0]).join('').toUpperCase() || 'TR'
    : context === 'player'
    ? profile?.full_name?.split(' ').map(n => n[0]).join('').toUpperCase() || 'PL'
    : context === 'academy'
    ? activeAcademy?.name?.substring(0, 2).toUpperCase() || 'AC'
    : activeClub?.location?.name?.substring(0, 2).toUpperCase() || 'CL';

  const handleSwitchToTrainer = () => {
    navigate('/app/trainer');
  };

  const handleSwitchToClub = (club?: ClubWithLocation) => {
    if (context === 'club' && club && onClubChange) {
      onClubChange(club);
    } else {
      navigate('/app/club');
    }
  };

  const handleClubSelect = (club: ClubWithLocation) => {
    if (context === 'club' && onClubChange) {
      onClubChange(club);
    } else {
      // Navigate to club dashboard when switching from trainer/academy context
      navigate('/app/club');
    }
  };

  const handleAcademySelect = (academy: AcademyWithRole) => {
    if (context === 'academy' && onAcademyChange) {
      onAcademyChange(academy);
    } else {
      // Navigate to academy dashboard when switching from trainer/club context
      navigate('/app/academy');
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button 
          variant="ghost" 
          className={collapsed ? "h-9 w-9 p-0" : "flex items-center gap-2 h-auto py-1.5 px-2 w-full justify-start"}
        >
          <Avatar className="h-7 w-7">
            <AvatarImage src={displayAvatar || undefined} />
            <AvatarFallback className="text-xs bg-primary/10 text-primary">
              {initials}
            </AvatarFallback>
          </Avatar>
          {!collapsed && (
            <>
              <span className="font-medium text-sm max-w-[120px] truncate">
                {displayName}
              </span>
              <ChevronDown className="h-4 w-4 text-muted-foreground ml-auto" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {/* Trainer Section - show when trainer wants to switch back */}
        {isTrainer && (context === 'club' || context === 'academy') && (
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

        {/* Academies Section */}
        {academies.length > 0 && (
          <>
            {clubs.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="flex items-center gap-2">
              <GraduationCap className="h-4 w-4" />
              {t('myAcademies')}
            </DropdownMenuLabel>
            {academies.map((academy) => (
              <DropdownMenuItem
                key={academy.id}
                onClick={() => handleAcademySelect(academy)}
                className="flex items-center gap-2 cursor-pointer"
              >
                <Avatar className="h-6 w-6">
                  <AvatarImage src={academy.logo_url || undefined} />
                  <AvatarFallback className="text-xs bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">
                    {academy.name?.substring(0, 2).toUpperCase() || 'AC'}
                  </AvatarFallback>
                </Avatar>
                <span className="flex-1 truncate">{academy.name}</span>
                {context === 'academy' && academy.id === activeAcademyId && (
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

        {/* Switch to Academy when in trainer context */}
        {isAcademyManager && context === 'trainer' && academies.length === 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center gap-2">
              <GraduationCap className="h-4 w-4" />
              {t('switchRole')}
            </DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => navigate('/academy')}
              className="flex items-center gap-2 cursor-pointer"
            >
              <Avatar className="h-6 w-6">
                <AvatarFallback className="text-xs bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">
                  AC
                </AvatarFallback>
              </Avatar>
              <span className="flex-1">{t('academyDashboard')}</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
