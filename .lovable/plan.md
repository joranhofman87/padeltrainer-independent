

# Add Academy Support to ProfileSwitcher

## Overview
Extend the ProfileSwitcher component to support Academy manager switching, following the same pattern used for Clubs. This allows users like Rene who are both trainers and academy managers to easily switch between their roles from anywhere in the app.

## Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `src/hooks/useAuth.tsx` | Modify | Add `isAcademyManager` flag and academy manager check |
| `src/components/ProfileSwitcher.tsx` | Modify | Add academy context, fetch academies, render academy section |
| `src/i18n/locales/en/common.json` | Modify | Add `myAcademies` and `academyDashboard` translations |
| `src/i18n/locales/nl/common.json` | Modify | Add Dutch translations |

## Implementation Details

### 1. Update useAuth Hook

Add `isAcademyManager` state and fetch academy manager status alongside club manager status:

```tsx
// Add import
import { isUserAcademyManager } from '@/lib/academy';

// Add to AuthContextType interface
interface AuthContextType {
  // ... existing fields
  isAcademyManager: boolean;
}

// Add state
const [isAcademyManager, setIsAcademyManager] = useState(false);

// Update fetchUserData to include academy check
const fetchUserData = async (userId: string) => {
  const [userRoles, userProfile, clubManagerStatus, academyManagerStatus] = await Promise.all([
    getUserRoles(userId),
    getProfile(userId),
    isUserClubManager(userId),
    isUserAcademyManager(userId),  // NEW
  ]);
  
  // ... existing role logic
  setIsAcademyManager(academyManagerStatus);
};

// Update context provider value
<AuthContext.Provider value={{ 
  // ... existing
  isAcademyManager,
}}>
```

### 2. Update ProfileSwitcher Component

#### Add Academy Context Support

```tsx
// Update imports
import { GraduationCap } from 'lucide-react';
import { getUserAcademyProfiles, type AcademyProfile } from '@/lib/academy';

// Update props interface
interface ProfileSwitcherProps {
  context?: 'club' | 'trainer' | 'player' | 'academy';  // Add 'academy'
  activeClubId?: string;
  activeAcademyId?: string;  // NEW
  onClubChange?: (club: ClubWithLocation) => void;
  onAcademyChange?: (academy: AcademyWithRole) => void;  // NEW
}

// Add academy type
interface AcademyWithRole extends AcademyProfile {
  role: string;
}
```

#### Fetch Academies

```tsx
const [academies, setAcademies] = useState<AcademyWithRole[]>([]);

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
      console.error('Error fetching profiles:', error);
    } finally {
      setLoading(false);
    }
  }

  fetchData();
}, [user]);
```

#### Update Show Switcher Logic

```tsx
const hasMultipleAcademies = academies.length > 1;
const hasMultipleOrganizations = clubs.length > 0 || academies.length > 0;

// Show switcher if user has multiple roles, clubs, or academies
const showSwitcher = 
  (isTrainer && (isClubManager || isAcademyManager)) ||
  hasMultipleClubs ||
  hasMultipleAcademies ||
  (isClubManager && isAcademyManager);
```

#### Add Academy Section to Dropdown

```tsx
{/* Academies Section */}
{academies.length > 0 && (
  <>
    {(clubs.length > 0 || (isTrainer && context !== 'trainer')) && (
      <DropdownMenuSeparator />
    )}
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
          <AvatarFallback className="text-xs bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">
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
```

#### Add Handler Functions

```tsx
const handleSwitchToAcademy = (academy?: AcademyWithRole) => {
  if (context === 'academy' && academy && onAcademyChange) {
    onAcademyChange(academy);
  } else {
    navigate('/academy');
  }
};

const handleAcademySelect = (academy: AcademyWithRole) => {
  if (context === 'academy' && onAcademyChange) {
    onAcademyChange(academy);
  } else {
    navigate('/academy');
  }
};
```

#### Update Display Logic for Academy Context

```tsx
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
```

### 3. Add Translation Keys

**English (`en/common.json`):**
```json
{
  "myAcademies": "My Academies",
  "academyDashboard": "Academy Dashboard"
}
```

**Dutch (`nl/common.json`):**
```json
{
  "myAcademies": "Mijn Academies",
  "academyDashboard": "Academy Dashboard"
}
```

## Visual Structure

```text
ProfileSwitcher Dropdown Menu:
+----------------------------------+
| 🔄 Switch Role                   |  <- Shows when in club/academy context
+----------------------------------+
| 👤 Trainer Dashboard             |  <- For trainers to switch back
+----------------------------------+
| 🏢 My Clubs                      |
| ├─ 🏠 Club Name 1        ✓      |
| └─ 🏠 Club Name 2               |
+----------------------------------+
| 🎓 My Academies          ← NEW  |
| ├─ 📚 Academy Name 1     ✓ NEW  |
| └─ 📚 Academy Name 2       NEW  |
+----------------------------------+
```

## Context Flow

```text
context: 'trainer'
├── Shows: "Switch Role" to Club (if club manager)
├── Shows: "My Clubs" section with all clubs
└── Shows: "My Academies" section with all academies ← NEW

context: 'club'  
├── Shows: "Switch Role" to Trainer (if trainer)
├── Shows: "My Clubs" with active club highlighted
└── Shows: "My Academies" section ← NEW

context: 'academy' ← NEW
├── Shows: "Switch Role" to Trainer (if trainer)
├── Shows: "My Clubs" section
└── Shows: "My Academies" with active academy highlighted
```

## Result

After implementation:
- Rene (and other academy managers) will see their academies in the ProfileSwitcher
- One-click navigation to `/academy` dashboard from any context
- Support for users managing multiple academies
- Consistent UI pattern with clubs (avatar, name, checkmark for active)
- `isAcademyManager` available in useAuth for other components to use

