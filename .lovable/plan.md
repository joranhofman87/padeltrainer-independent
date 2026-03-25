

# Move Academy "About" Section Below Trainers

## Problem
The academy description is currently passed as the `quote` prop on the `ProfileHeroCard`, making it too long and cluttered in the hero area. It should be in its own card below the trainers section.

## Changes

### `src/pages/AcademyPublicProfile.tsx`

1. **Remove** the `quote={academy.description || undefined}` prop from `ProfileHeroCard` (line 296)

2. **Add** a new "About" card after the Trainers section (after line 438), before Reviews:
```tsx
{academy.description && (
  <ProfileFullWidthSection>
    <Card>
      <CardHeader>
        <CardTitle>{t('common:aboutAcademy', 'About')} {academy.name}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground whitespace-pre-line">{academy.description}</p>
      </CardContent>
    </Card>
  </ProfileFullWidthSection>
)}
```

Two small edits in one file.

