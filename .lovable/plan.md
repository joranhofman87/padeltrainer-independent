## Pin invoice language to the academy, not the sender's UI

### The actual problem

Right now `send-invoice-email` uses whatever language is passed in from the UI, and the UI passes `i18n.language` of the logged-in user (the trainer or academy manager sending the invoice). That value comes from the browser's i18next detector and can flip to English the moment the manager toggles the UI, opens the app on a different device, or has their browser language change. There is no field on `academy_profiles` or `trainer_profiles` that says "always send invoices in Dutch", and `guest_players` has no language either. The only language field anywhere is `profiles.preferred_language`, which only exists for registered players.

So for RL Padel Performance — even though their academy is Dutch — recipients can receive English emails purely based on who clicked Send.

### Goal

The recipient's email language should be deterministic and independent of the sender's UI:

1. If the recipient is a registered player with `profiles.preferred_language` set → use that.
2. Otherwise → use the academy/trainer's configured invoice language.
3. Fallback → `nl`.

The sender's `i18n.language` should NOT influence the email anymore.

### Changes

**1. Database — add a per-organization invoice language**

Add a column to both organization tables, default `'nl'`:
- `academy_profiles.invoice_language text not null default 'nl'`
- `trainer_profiles.invoice_language text not null default 'nl'`

Backfill: leave default `'nl'` for everyone (matches today's behavior and explicitly fixes RL Padel Performance and every other Dutch academy). No manual data migration needed for RL.

**2. `send-invoice-email/index.ts` — resolve language server-side**

Replace the current `language = body.language || 'nl'` with:

```
1. If invoice.player_id → look up profiles.preferred_language
2. Else if invoice.academy_profile_id → use academy_profiles.invoice_language
3. Else if invoice.trainer_id → use trainer_profiles.invoice_language
4. Fallback 'nl'
```

Ignore any `language` field from the request body (or keep it only as an explicit override for the bulk-email preview/test send dialog, where the sender deliberately picks the language). For real sends, the body value is dropped.

This means subject prefix ("Factuur"), email body copy, currency/date formatting, and the public invoice URL locale segment all follow the recipient's language — which for RL is Dutch, always.

**3. UI — surface the setting in invoice settings**

Add a single dropdown in academy invoice settings and trainer invoice settings:
"Default invoice language" → NL / EN / ES / DE / FR / IT. Default NL. This is what gets persisted to `invoice_language` and used for any guest/unregistered recipient.

For registered players, an explainer note: "Players with a language preference on their account get invoices in their own language."

**4. Stop passing `i18n.language` from senders**

Remove `language: i18n.language || "nl"` from the 8 invoke sites in:
- `src/pages/trainer/TrainerInvoices.tsx` (3)
- `src/pages/academy/AcademyInvoices.tsx` (3)
- `src/components/trainer/InvoiceList.tsx` (2)

Keep it on `BulkInvoiceEmailDialog` only for preview/test sends inside that dialog (so the manager can preview in any language). Real sends from the bulk dialog should also drop the override and rely on per-recipient resolution — confirm with you.

**5. `forward-invoice` (copy to the trainer's own inbox)**

Already hardcoded Dutch. Leave as-is — it goes to the trainer/academy themselves, not to recipients.

### Files touched

- New migration: add `invoice_language` columns
- `supabase/functions/send-invoice-email/index.ts`
- `src/pages/academy/AcademyInvoiceSettings.tsx` (or equivalent settings file) + trainer equivalent
- `src/pages/trainer/TrainerInvoices.tsx`, `src/pages/academy/AcademyInvoices.tsx`, `src/components/trainer/InvoiceList.tsx` — remove `language` from invokes
- `nl/` and `en/` translation files for the new settings field

### One question for you

For the bulk-send dialog, when the manager is actually sending (not previewing/testing), should the picked language **override** the per-recipient resolution, or should each recipient still get their own language? The clean behavior is per-recipient resolution always, with the dropdown labelled "Preview in:" so it's clear it's only for the preview. Confirm or tell me you want the override behavior.
