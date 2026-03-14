

# Collapse Scoring Weights Behind Presets + Collapsible Detail

## Current State
Step 2 of the wizard always shows all 6 sliders plus the rating spread section, taking up a lot of vertical space. Users must scroll through it even if they just want "Balanced."

## Proposed UX
- Show the 3 preset buttons prominently (Balanced, Time-focused, Level-focused) — selecting one sets the weights immediately
- Below the presets, add a **collapsible section** ("Customize weights") using an accordion/disclosure pattern
- When expanded, show the 6 sliders + total indicator
- The rating spread section stays always visible below (it's a separate concern)
- Default state: collapsed (preset selected = "Balanced")

## Changes

### `src/components/cycles/ScoringWeightsPanel.tsx`
- Wrap the sliders section in a `Collapsible` (from radix/shadcn)
- Add a trigger button: "Customize weights ▸" that toggles open/closed
- Auto-expand when user has customized (i.e. no preset is active)
- Keep presets, total indicator, and rating spread outside the collapsible

### Translation files (`en`, `nl`, `es`, `de`, `fr`)
- Add key `proposals.weights.customize` — "Customize weights" / "Gewichten aanpassen" / etc.

No changes needed to `GenerateProposalsWizard.tsx` or `ScoringWeightsDialog.tsx` — the panel handles it internally.

