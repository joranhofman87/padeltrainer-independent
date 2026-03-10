

## Move "Experience" Notes Field Into the Personal Info Card

The "notes" (ervaring/experience) textarea currently lives in a separate "Additional Info" card at the bottom of the form. Move it into the Personal Info card, right after the rating/level fields.

### Changes

**`src/components/cycles/CycleApplicationForm.tsx`**

1. **Add notes field after the rating grid** (after line 421, inside the Personal Info `<CardContent>`):
   - Move the `notes` `FormField` (currently lines 681-696) to right after the rating `grid grid-cols-2` block
   - Keep the same `Textarea` with the existing placeholder and translation keys

2. **Remove notes from the "Additional Info" card** (lines 675-727):
   - Remove the `notes` FormField from this card
   - The card still keeps `consent` and `TermsAcceptance`, so rename the card title from "additional" to something like consent/agreement, or simply remove the `CardHeader` since consent is self-explanatory
   - Actually, keep the card but just remove the notes field from it — the card header "Additional Info" with consent + terms still makes sense

