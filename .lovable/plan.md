

## Remove Password from Registration, Send "Set Your Password" Email Instead

**Goal**: Guests submit the form with just their email (no password). The system creates their account server-side and sends a branded "Complete your account" email with a magic link / password-set link. Zero friction at submission time.

### How it works today
- Guest users fill in email + password at the bottom of the form
- On submit, `supabase.auth.signUp()` is called client-side with the password
- Then the `submit-guest-intake` edge function handles the intake record

### What changes

**1. Remove password from the form (`CycleApplicationForm.tsx`)**
- Remove the `password` field from the Zod schema (no longer required for guests)
- Remove the password `FormField` from the "Create Your Account" card
- Update the card title/description to just say "Your Email" or similar — no mention of account creation
- Remove the `password` default value from `useForm`

**2. Update the guest submit flow (`CycleApplicationForm.tsx`)**
- Instead of calling `supabase.auth.signUp()` client-side, pass the email + name to `submit-guest-intake` and let the edge function handle account creation
- Remove the client-side signup code and the 1500ms wait for profile trigger

**3. Update `submit-guest-intake` edge function**
- Before inserting the intake request, check if a user with this email already exists
- If no user exists: create one via `supabaseAdmin.auth.admin.createUser()` with `email_confirm: true` and a random generated password (user won't know it)
- Then generate an invite/magic link via `supabaseAdmin.auth.admin.generateLink({ type: 'magiclink' })` 
- Send a branded "Complete your account" email via Resend with a link to set their password (using the existing Resend setup from `signup-user`)
- If user already exists: just proceed with the intake submission using their existing user ID

**4. Create the "Complete Your Account" email template (inside edge function)**
- Branded email matching the existing PadelTrainer style (logo, orange button, same footer)
- CTA: "Set Your Password" linking to a password-reset/setup flow
- Copy: "Thanks for registering! Set a password to access your account and track your registration."

### Files to change
- `src/components/cycles/CycleApplicationForm.tsx` — remove password field, simplify guest flow
- `supabase/functions/submit-guest-intake/index.ts` — add user creation + welcome email logic

### UX result
- Guest fills in name, preferences, email → clicks Submit → done
- They receive a branded email: "Set your password to access your account"
- If they never set a password, their registration is still recorded and visible to the trainer

