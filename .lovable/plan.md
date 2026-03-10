

# Rethink Trainer Onboarding: PLG-Focused Time to Value

## Problem with Current Flow

The current 4-step onboarding is **setup-heavy, not value-focused**:

1. **Goal survey** — collects data but delivers zero value to the trainer
2. **Full profile** — asks for name, bio, phone, locations, specializations, rating system (6+ fields)
3. **Create session + add slots** — complex two-part form (session details then availability)
4. **Done screen** — "nice, now go review things"

This is classic "fill out forms before you see anything" anti-pattern. The trainer does 5+ minutes of work before experiencing any value. The "aha moment" (seeing their live profile page) only happens *after* completing everything.

## PLG Principles to Apply

- **Time to Value**: Get trainers to their "aha moment" (seeing a live, shareable profile) in under 90 seconds
- **Progressive disclosure**: Only ask what's needed *now*, defer the rest
- **Show, don't tell**: Let them see their profile building in real-time
- **Endowed progress**: Start them with something already done

## Redesigned Flow: 2 Steps + Smart Checklist

### Step 1: "Let's get you live" (60 seconds)
Only 3 fields — the absolute minimum to generate a profile page:
- **Name** (pre-filled from signup if available)
- **One-liner bio** (placeholder: "Padel trainer in [city]" — keep it simple)
- **Hourly rate** (single number)

On submit → immediately show a **live preview of their public profile page** right in the onboarding, with a "This is what players will see" label. This is the aha moment.

### Step 2: "You're ready — here's your profile" (Celebration + next steps)
- Show the profile preview link (copyable/shareable)
- "Your profile is private until you publish it"
- CTA: "Go to your dashboard" → lands on the Get Started checklist

### Post-Onboarding: Enhanced Get Started Checklist
Move everything that was crammed into onboarding into the existing checklist, reordered by impact:
1. Add your first time slots (availability)
2. Set up payments (Mollie or manual)
3. Add training locations
4. Add your existing players
5. Publish your profile

The checklist already exists and works well. The key insight: **the checklist IS the onboarding** — the wizard should just get them into the product fast.

### What gets removed/deferred
| Currently in onboarding | New location |
|---|---|
| Goal survey (Step 1) | **Removed** — track via PostHog instead, or add as optional survey later |
| Phone number | Checklist / profile settings |
| Locations | Checklist / profile settings |
| Specializations | Checklist / profile settings |
| Rating system | Checklist / profile settings (default: KNLTB) |
| Session creation | Checklist (add availability) |
| Slot/cycle creation | Checklist (add availability) |

### What about the goal survey data?
The Step 1 goal survey collects useful segmentation data but adds friction. Two options:
- **Remove entirely** — track behavior via PostHog instead (what they actually do > what they say)
- **Move to a post-activation micro-survey** — show it after they've published or gotten their first booking

I'd recommend removing it from the wizard and adding a small in-app survey trigger after they complete 2+ checklist items.

## Files to Modify

| File | Change |
|---|---|
| `src/pages/TrainerOnboarding.tsx` | Simplify to 2 steps, remove step 1 goal + step 3 schedule |
| `src/components/trainer/onboarding/OnboardingStep1Goal.tsx` | **Delete** or repurpose as post-activation survey |
| `src/components/trainer/onboarding/OnboardingStep2Profile.tsx` | **Rewrite** → new Step 1 with only name, bio, rate |
| `src/components/trainer/onboarding/OnboardingStep3Schedule.tsx` | **Remove from onboarding** (stays available in dashboard) |
| `src/components/trainer/onboarding/OnboardingStep4Done.tsx` | **Rewrite** → new Step 2 with profile preview + share link |
| `src/components/trainer/onboarding/OnboardingProgressBar.tsx` | Update for 2 steps |
| `src/components/trainer/TrainerSetupChecklist.tsx` | Minor: reorder items, add locations/specializations steps |
| DB migration | Update `trainer_onboarding` table: `current_step` max becomes 2, goal fields become nullable |

