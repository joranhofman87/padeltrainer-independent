## Fix weak temp password generation

Replace `Math.random()` in `supabase/functions/create-admin-trainer/index.ts` `generatePassword()` with `crypto.getRandomValues()` (Web Crypto API, available in Deno).

### Change
```ts
function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}
```

### After
- Mark `weak_temp_password_gen` finding as fixed.

No other files affected.