

# Add ProfileSwitcher to TrainerSidebar

## Overview
Add the ProfileSwitcher component to the TrainerSidebar footer. The ProfileSwitcher already supports both clubs AND academies - it fetches both and displays them in separate sections. The issue is simply that TrainerSidebar doesn't include this component yet.

## What Will Show for Rene

Once ProfileSwitcher is added to TrainerSidebar, if Rene is:
- **Academy Manager only** → Shows "My Academies" section
- **Club Manager only** → Shows "My Clubs" section  
- **Both Academy + Club Manager** → Shows both sections:

```
+----------------------------------+
| 🏢 My Clubs                      |
| └─ 🏠 Club Name                  |
+----------------------------------+
| 🎓 My Academies                  |
| └─ 📚 RL Padel Performance       |
+----------------------------------+
```

## Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `src/components/trainer/TrainerSidebar.tsx` | Modify | Add ProfileSwitcher to sidebar footer |
| `src/components/academy/AcademyLayout.tsx` | Modify | Add `context="academy"` prop to existing ProfileSwitcher |

## Implementation Details

### 1. TrainerSidebar - Add ProfileSwitcher

```tsx
// Add import at top
import { ProfileSwitcher } from '@/components/ProfileSwitcher';

// In SidebarFooter, add ProfileSwitcher before the View Profile button
<SidebarFooter className="border-t">
  <div className={cn(
    "flex p-2",
    collapsed ? "flex-col items-center gap-2" : "flex-col gap-2"
  )}>
    {/* NEW: Profile Switcher for clubs/academies */}
    <ProfileSwitcher context="trainer" />
    
    {/* Existing: View Public Profile button */}
    {trainerProfileId && (
      <Button variant="outline" ...>
        ...
      </Button>
    )}
    
    {/* Existing: Theme toggle and logout */}
    <div className={cn(...)}>
      <ThemeToggle />
      <Button variant="ghost" onClick={handleLogout}>
        <LogOut className="h-4 w-4" />
        ...
      </Button>
    </div>
  </div>
</SidebarFooter>
```

### 2. AcademyLayout - Fix ProfileSwitcher props

```tsx
// Line 163: Add context prop
<ProfileSwitcher 
  context="academy"
  activeAcademyId={activeAcademy?.id} 
/>
```

## Visual Result

**TrainerSidebar Footer (Rene's view):**
```
+----------------------------------+
| [ProfileSwitcher ▼]              |  <- Click to see clubs + academies
| [View Public Profile 🔗]         |
| [🌓] [Logout 🚪]                 |
+----------------------------------+
```

**ProfileSwitcher Dropdown (if both club + academy manager):**
```
+----------------------------------+
| 🏢 My Clubs                      |
| └─ 🏠 Club ABC                   |
+----------------------------------+
| 🎓 My Academies                  |
| └─ 📚 RL Padel Performance       |
+----------------------------------+
```

## Result
- Rene (and any trainer) will see ProfileSwitcher in the sidebar footer
- If they manage clubs → shows "My Clubs"
- If they manage academies → shows "My Academies"  
- If they manage both → shows both sections
- Clicking navigates to the respective `/club` or `/academy` dashboard

