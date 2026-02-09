
## Legacy Code Cleanup — COMPLETED ✅

All cleanup items from the final audit have been resolved:

1. ✅ **hasLessons bug fixed** — Removed from `SetupStatus` interface and `allComplete` check in `TrainerGetStarted.tsx` and `TrainerSetupChecklist.tsx`
2. ✅ **OnboardingStep3Schedule renamed** — All `lesson`→`session` variable renames and UI text updates
3. ✅ **Email templates updated** — Body text changed from "lesson" to "training session" in `send-email` edge function
4. ✅ **Calendar sync fixed** — Changed `Tennis:` prefix to `Padel:` and `Lesson` fallback to `Training Session`
5. ✅ **max_lessons removed** — Removed from `SubscriptionPlan` interface and `PlanEditDialog` form
6. ✅ **CalendarSettings text updated** — All "lessons" references changed to "training sessions"
7. ✅ **Stale comments cleaned** — Removed legacy Stripe/subscription references from `useAuth.tsx` and `subscription.ts`

### Note
The `lessonTitle`/`lessonDate`/`lessonTime` parameter names in `email.ts` and call sites were kept as-is since they're internal property keys with no user-facing impact. The email *body text* was updated to say "training session" instead of "lesson".
