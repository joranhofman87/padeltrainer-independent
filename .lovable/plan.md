

# Accessibility Improvement Plan

Based on your Lighthouse report (score: 80), there are 4 categories of issues to fix. All are quick, non-breaking changes.

---

## Issues and Fixes

### 1. Buttons without accessible names
The mobile hamburger menu button in `MarketingLayout.tsx` (line 163) has no `aria-label`.

**Fix**: Add `aria-label="Open menu"` / `"Close menu"` based on state.

### 2. Links without discernible names
Footer social media links (LinkedIn, Facebook, Instagram, YouTube, TikTok — lines 274-290) only contain icons with no text or `aria-label`.

**Fix**: Add `aria-label` to each social link (e.g., `aria-label="LinkedIn"`, `aria-label="Facebook"`, etc.).

### 3. Images without alt attributes
The `<Logo />` component used in header/footer links may not have an alt attribute. The logo links themselves also lack discernible text.

**Fix**: Ensure the Logo SVG has `role="img"` and an appropriate `aria-label`, or add `aria-label="PadelTrainer home"` to the logo links.

### 4. Contrast ratio — "Start free trial" CTA
The primary button (`--primary: 16 90% 55%` = coral/orange `#F26522`) with white text fails WCAG AA contrast (ratio ~3.1:1, needs 4.5:1). This is the specific element flagged in your screenshot.

**Fix**: Darken `--primary` slightly from `16 90% 55%` to `16 90% 45%` (deeper orange, ratio ~5.5:1). This preserves the brand feel while passing AA. We only change the light-mode value; dark mode already renders differently.

---

## Files to change
- `src/components/marketing/MarketingLayout.tsx` — aria-labels on mobile menu button, social links, logo links
- `src/index.css` — darken `--primary` lightness from 55% to 45%
- `src/components/home/HeroSection.tsx` — verify Logo component accessibility

These are all small, targeted changes that won't affect layout or functionality.

