

# Add Social Media Links to Marketing Footer

Add a row of social media icon links to the footer of `MarketingLayout.tsx`, placed between the grid columns and the copyright line.

## Changes

### `src/components/marketing/MarketingLayout.tsx`

Add a social icons row after the existing grid (before the copyright `border-t` div):

- LinkedIn: https://www.linkedin.com/company/padel-trainer/
- Facebook: https://www.facebook.com/people/PadelTrainerai/61587581553043/
- Instagram: https://www.instagram.com/padeltrainerai/
- YouTube: https://www.youtube.com/@PadelTrainerAI
- TikTok: https://www.tiktok.com/@padeltrainer.ai

Icons will use Lucide (`Linkedin`, `Facebook`, `Instagram`, `Youtube`) and a custom inline SVG for TikTok (same pattern already used in `ProfileSocialCard`). Rendered as a centered `flex` row of icon links with `hover:text-primary` transitions, placed just above the copyright section.

No new files, no translations needed -- just 5 icon anchor tags added to the existing footer.

