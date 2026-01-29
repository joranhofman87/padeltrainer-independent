
# Plan: Add Clickable Row Functionality to Admin Tables

## Overview

Enable clicking on table rows in the admin panel to directly open the edit popup for Clubs, Academies, Trainers, and Users. This improves UX by providing a faster way to access entity details without needing to click the dropdown menu.

## Implementation Approach

For each admin table, add an `onClick` handler to the `TableRow` component that triggers the same edit state as the dropdown menu action. The row will also get a `cursor-pointer` class to indicate it's clickable.

### Key Considerations

1. **Prevent event bubbling**: The dropdown menu trigger button and checkbox (for users) should NOT trigger the row click. We'll use `e.stopPropagation()` on these interactive elements.
2. **Visual feedback**: Add `cursor-pointer` and `hover:bg-muted/50` classes to indicate clickability.
3. **Consistency**: All four entity types (Clubs, Academies, Trainers, Users) will have the same behavior.

## File Changes

### 1. AdminClubs.tsx

| Change | Details |
|--------|---------|
| Add onClick to TableRow | `onClick={() => setEditingClub(club)}` |
| Add cursor-pointer class | Visual indication of clickability |
| Stop propagation on dropdown | Prevent row click when using dropdown menu |

```typescript
// Before
<TableRow key={club.id}>

// After  
<TableRow 
  key={club.id} 
  className="cursor-pointer hover:bg-muted/50"
  onClick={() => setEditingClub(club)}
>
```

```typescript
// Dropdown button - add stopPropagation
<DropdownMenuTrigger asChild>
  <Button 
    variant="ghost" 
    size="icon" 
    onClick={(e) => e.stopPropagation()}
  >
```

### 2. AdminAcademies.tsx

| Change | Details |
|--------|---------|
| Add onClick to TableRow | `onClick={() => setEditingAcademy(academy)}` |
| Add cursor-pointer class | Visual indication of clickability |
| Stop propagation on dropdown | Prevent row click when using dropdown menu |

### 3. AdminTrainers.tsx

| Change | Details |
|--------|---------|
| Add onClick to TableRow | `onClick={() => setEditingTrainer(trainer)}` |
| Add cursor-pointer class | Visual indication of clickability |
| Stop propagation on dropdown | Prevent row click when using dropdown menu |

### 4. AdminUsers.tsx

| Change | Details |
|--------|---------|
| Add onClick to TableRow | `onClick={() => openEditDialog(user)}` |
| Add cursor-pointer class | Visual indication of clickability |
| Stop propagation on dropdown AND checkbox | Both need to prevent row click |

For users, clicking the row will open the edit dialog (not the role change dialog), as editing user details is the most common action. The edit dialog handler will need to set the user and open the dialog:

```typescript
// Row click handler for users
const handleRowClick = (user: UserWithRole) => {
  setSelectedUser(user);
  setEditName(user.full_name || "");
  setEditEmail(user.email || "");
  setEditDialogOpen(true);
};

<TableRow 
  key={u.user_id}
  className={cn("cursor-pointer hover:bg-muted/50", selectedUserIds.has(u.user_id) && "bg-muted/50")}
  onClick={() => handleRowClick(u)}
>

// Checkbox - add stopPropagation
<Checkbox
  checked={selectedUserIds.has(u.user_id)}
  onCheckedChange={() => toggleUserSelection(u.user_id)}
  onClick={(e) => e.stopPropagation()}
/>
```

## Summary of Changes

| File | Primary Change |
|------|----------------|
| `src/pages/admin/AdminClubs.tsx` | Row click opens ClubEditDialog |
| `src/pages/admin/AdminAcademies.tsx` | Row click opens AcademyEditDialog |
| `src/pages/admin/AdminTrainers.tsx` | Row click opens TrainerSubscriptionEditDialog |
| `src/pages/admin/AdminUsers.tsx` | Row click opens Edit User dialog |

## Technical Notes

- Using `e.stopPropagation()` ensures interactive elements (dropdowns, checkboxes) don't trigger the row click
- The `cursor-pointer` class provides visual feedback that rows are clickable
- Existing edit dialog/state logic is reused - no new components needed
