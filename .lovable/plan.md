

# Add "Create Academy" Option in Trainer Settings

## Overview
Add a new card in TrainerSettings that allows trainers who are not already part of an academy to create their own academy. This mirrors the existing "Player mode" toggle pattern but as a navigation action rather than a toggle.

## Design
Place a new card between the "Player mode" section and the settings grid (around line 348). It should:
- Only show when `hasAcademy` is `false`
- Use the `GraduationCap` icon with emerald coloring (consistent with academy branding elsewhere)
- Title: "Start an Academy" with description: "Create your own academy to manage trainers, players, and locations"
- Clicking navigates to `/app/onboarding/academy` (the existing academy onboarding flow)
- When `hasAcademy` is `true`, the existing "managed by academy" alert already shows — no duplication needed

## Files to Modify

| File | Change |
|---|---|
| `src/pages/TrainerSettings.tsx` | Add "Start an Academy" card section, import `GraduationCap` icon |
| `src/i18n/locales/*/trainer.json` | Add `settings.startAcademy` and `settings.startAcademyDescription` translation keys (5 languages) |

## Implementation Detail

In `TrainerSettings.tsx`, after the Player Mode card (~line 347) and before the settings grid, add:

```tsx
{!hasAcademy && (
  <div className="max-w-4xl mb-8">
    <Card className="cursor-pointer hover:shadow-lg transition-shadow hover:border-emerald-500/50"
          onClick={() => navigate('/app/onboarding/academy')}>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-emerald-500/10">
            <GraduationCap className="h-5 w-5 text-emerald-600" />
          </div>
          <div className="flex-1">
            <CardTitle className="text-lg">{t('settings.startAcademy')}</CardTitle>
            <CardDescription>{t('settings.startAcademyDescription')}</CardDescription>
          </div>
        </div>
      </CardHeader>
    </Card>
  </div>
)}
```

This reuses the existing academy onboarding flow at `/app/onboarding/academy` — no new pages needed.

