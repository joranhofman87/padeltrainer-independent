

# Rebrand Coach Pages: "Content Creators" with Disclaimer

## Problem
The current coach pages use language like "Padel Coach", "View trainer on PadelTrainer.ai", and "Learn from [name]" which implies these creators are trainers on the platform. They are independent content creators featured for their quality content.

## Changes

### 1. Coaches listing page (`src/pages/marketing/Coaches.tsx`)
- Update SEO title/description: "Padel Content Creators" or "Padel Coaches & Content Creators"
- Update hero subtitle to: "We curate the best padel content from independent coaches and creators. These creators are not affiliated with PadelTrainer.ai -- we feature them because of the quality of their tutorials, drills, and tips."
- Add a small disclaimer banner below the hero: an `Info` icon with text like "The creators featured on this page are independent content creators. They are not affiliated with or employed by PadelTrainer.ai. We showcase their content because of its quality and educational value."

### 2. Individual coach profile page (`src/pages/marketing/CoachPage.tsx`)
- Update SEO fallback from `"Padel Coach"` to `"Padel Content Creator"`
- Update SEO description fallback from `"Learn from {name} on PadelTrainer.ai"` to `"Watch quality padel content by {name}, featured on PadelTrainer.ai"`
- Change `"View trainer on PadelTrainer.ai"` button text to `"View on PadelTrainer.ai"` (line 275)
- Change `"Videos by {name}"` heading to `"Featured content by {name}"`
- Add a **disclaimer card** at the bottom of the hero section (inside the rounded box), styled subtly with an `Info` icon: "This creator is independently featured on PadelTrainer.ai for the quality of their content. They are not employed by or formally affiliated with our platform."
- Change breadcrumb label from `'Coaches'` to `'Creators'`

### 3. References from other pages
- `VideoTipPage.tsx` line ~152: the link text to coach profile -- no label change needed (just links to profile)
- `TopicPage.tsx` / `LearningArticlePage.tsx`: these show "Featured Trainers" sections linking to coach profiles -- update heading to "Featured Creators" if present

### Files to Change
| File | What |
|------|------|
| `src/pages/marketing/Coaches.tsx` | Hero copy, SEO meta, add disclaimer banner |
| `src/pages/marketing/CoachPage.tsx` | SEO meta, hero disclaimer card, rename "trainer" references, breadcrumb |
| `src/pages/marketing/TopicPage.tsx` | Rename "Featured Trainers" heading if used |
| `src/pages/marketing/LearningArticlePage.tsx` | Same as above |

