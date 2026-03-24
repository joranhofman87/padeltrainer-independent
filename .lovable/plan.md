

# Visually Separate Club Content from Learning Content

## Problem
The "Learn to Play Padel" section flows directly after the club-specific sections (trainers, academies, similar clubs), making it feel like one continuous block rather than a distinct content area.

## Solution
Add a visual separator between the club content and the learning section using a distinct background color, a decorative divider, and slightly different styling to create a clear "you're now in a different section" feel.

### `src/components/locations/LocationLearnSection.tsx`
- Wrap the entire section in a distinct background container (e.g., `bg-muted/30` or a subtle gradient like `bg-gradient-to-b from-muted/40 to-background`) with rounded corners and padding
- Add a top border or decorative separator line above the section
- Add a small intro line under the heading like "Improve your game with guides, techniques, and video tips" to reinforce this is educational content, not club info
- Replace `ProfileFullWidthSection` wrapper with a custom styled `div` that has the background treatment, or add the background inside the existing wrapper

The key visual changes:
1. A horizontal rule / separator with some vertical spacing before the section
2. A subtle background tint (`bg-muted/30 rounded-xl p-6`) on the learn section content
3. A subtitle under "Learn to Play Padel" to set context

### Translation keys (`common.json` x5)
- Add `locations.learnPadelSubtitle` — "Improve your game with guides, techniques and video tips"

### Files
- `src/components/locations/LocationLearnSection.tsx`
- `src/i18n/locales/{en,nl,es,de,fr}/common.json`

