

## Add Email Field Above Password in Create Account Card

**File:** `src/components/cycles/CycleApplicationForm.tsx`

Add a read-only email `FormField` inside the "Create Your Account" card, between the description text (line 737) and the password field (line 739). This shows the email they entered at the top so they can confirm which email their account will use.

The email field will display the value from `form.watch('email')` as a disabled/read-only input so users can see but not edit it here (they already entered it in the Personal Info card above).

