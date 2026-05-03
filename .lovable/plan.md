## Probleem

Bij het aanmaken van een factuur via `auto-create-invoice` wordt `sent_at = now()` direct ingevuld zodra de status "sent" (gefinaliseerd) is, ook al is er geen e-mail verstuurd. De UI leidt het label "Verstuurd" / "Te laat" af van `sent_at`, dus elke gefinaliseerde factuur lijkt verstuurd.

Daarnaast stempelt `send-invoice-email` op dit moment `sent_at` niet na een echt verstuurde mail. We willen `sent_at` puur reserveren voor het werkelijke e-mailmoment.

## Aanpak

**1. Edge function `auto-create-invoice`**
- Verwijder het automatisch zetten van `sent_at` bij status `sent` (regel 515).
- Behoud `sent_at = now()` alleen wanneer de factuur direct als `paid` wordt aangemaakt (Mollie-flow), aangezien een betaalde factuur impliciet bezorgd is.

**2. Edge function `send-invoice-email`**
- Na succesvolle Resend-verzending: update de factuur met `sent_at = now()` als die nog `null` is, en zet `status = 'sent'` als hij nog `draft` was. Zo wordt `sent_at` de bron-van-waarheid voor "echt verstuurd".

**3. UI label-logica (`AcademyInvoices.tsx` + `TrainerInvoices.tsx`)**
Huidige `getComputedStatus`:
```ts
if (inv.sent_at && due < now) return "overdue";
if (inv.sent_at) return "sent";
return "draft";
```
Probleem: facturen met `status='sent'` zonder `sent_at` vallen nu onder "draft", wat onjuist is (ze zijn wel gefinaliseerd, alleen niet gemaild).

Nieuw gedrag:
```ts
if (inv.status === "paid") return "paid";
if (inv.status === "cancelled") return "cancelled";
if (inv.sent_at && due < now) return "overdue";
if (inv.sent_at) return "sent";              // echt gemaild
if (inv.status === "draft") return "draft";  // concept
return "open";                                // gefinaliseerd, niet gemaild
```
Voeg label/badge toe voor `open` (NL: "Open", EN: "Open") met neutrale styling. Werk filters en tellers (`draftInvoices`, statusfilter) bij zodat `open` een eigen filteroptie krijgt en niet ten onrechte als concept telt.

**4. Data-cleanup migratie**
Wis `sent_at` voor facturen waar het automatisch werd gestempeld bij creatie (geen bewijs van echte verzending). Heuristiek:
```sql
UPDATE invoices
SET sent_at = NULL
WHERE status = 'sent'
  AND paid_at IS NULL
  AND sent_at IS NOT NULL
  AND ABS(EXTRACT(EPOCH FROM (sent_at - created_at))) < 5;
```
Dit raakt facturen waar `sent_at` binnen 5 seconden van `created_at` ligt (auto-stempel). Handmatig via "Mark as sent" gezette stempels (later moment) blijven intact. Betaalde facturen blijven onaangeraakt.

## Bestanden

- `supabase/functions/auto-create-invoice/index.ts` — verwijder `sent_at` bij status `sent`.
- `supabase/functions/send-invoice-email/index.ts` — stempel `sent_at` + `status` na succesvolle verzending.
- `src/pages/academy/AcademyInvoices.tsx` — uitgebreide `getComputedStatus`, `open`-badge, filter-update.
- `src/pages/trainer/TrainerInvoices.tsx` — zelfde wijzigingen voor parity.
- Nieuwe SQL-migratie voor cleanup.

## Niet in scope

- Geen aparte `email_log` tabel (overkill voor nu); `sent_at` blijft de marker.
- Geen wijziging aan `BulkInvoiceEmailDialog` of "Mark as sent"-knop, die zetten al correct `sent_at`.
