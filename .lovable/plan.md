

## Hide Subscription & Mollie for Academy Trainers

### What's changing

Trainers who belong to an academy will no longer see the subscription page, subscription sidebar link, or subscription paywall overlay. Instead, they'll see a note that their subscription is managed by their academy. The Mollie/Earnings page already handles this correctly.

### Changes

**1. Sidebar (`src/components/trainer/TrainerSidebar.tsx`)**
- Wrap the "Subscription" link (lines 463-472) with `!hasAcademy &&` guard, same pattern already used for "Earnings"

**2. Settings Page (`src/pages/TrainerSettings.tsx`)**
- Fetch `hasAcademy` status (reuse `getTrainerAcademy`)
- Filter out the "Subscription" settings card when the trainer belongs to an academy
- Optionally show a small info card: "Your subscription is managed by your academy"

**3. Trainer Layout (`src/components/trainer/TrainerLayout.tsx`)**
- Import and check academy membership before showing the `SubscriptionOverlay`
- Fetch `hasAcademy` status using `getTrainerAcademy` (same as sidebar)
- Skip the paywall overlay when the trainer belongs to an academy

**4. Translation keys**
- Add `settings.managedByAcademy` key in `en/trainer.json` and `nl/trainer.json` for the info message

### Technical Details

**Sidebar change** (simple guard):
```tsx
{!hasAcademy && (
  <SidebarMenuSubItem>
    <SidebarMenuSubButton asChild>
      <NavLink to="/trainer/subscription" ...>
        {t("nav.subscription")}
      </NavLink>
    </SidebarMenuSubButton>
  </SidebarMenuSubItem>
)}
```

**Layout paywall skip:**
- Add state `hasAcademy` fetched on mount via `getTrainerAcademy`
- Change overlay condition from `isSubscriptionExpired && !isOnSubscriptionPage` to also require `!hasAcademy`

**Settings filter:**
- Add `hasAcademy` state, fetch on mount
- Filter `settingsItems` to exclude the subscription card when `hasAcademy` is true
- Show an info Alert instead: "Your subscription and payments are managed by your academy"

### Files to modify
- `src/components/trainer/TrainerSidebar.tsx` -- hide subscription link for academy trainers
- `src/components/trainer/TrainerLayout.tsx` -- skip paywall for academy trainers
- `src/pages/TrainerSettings.tsx` -- hide subscription card, show academy info
- `src/i18n/locales/en/trainer.json` -- add `settings.managedByAcademy` key
- `src/i18n/locales/nl/trainer.json` -- add Dutch equivalent
