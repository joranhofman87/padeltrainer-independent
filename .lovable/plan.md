## Bump ResetPassword min length to 8

Yes — `src/pages/ResetPassword.tsx:49` still enforces `< 6`, while `validation.ts` treats 8 as the minimum strong-password baseline. Align the reset flow with the rest of the app.

### Change
In `src/pages/ResetPassword.tsx` `handleSubmit`:
- Replace `if (password.length < 6)` with `if (password.length < 8)`.
- Update the toast description fallback string to "Password must be at least 8 characters".
- Update the i18n key `resetPassword.passwordTooShort` default to match (translation files keep existing keys; English fallback updated inline — translations can be refreshed separately if desired).

No other files affected.
