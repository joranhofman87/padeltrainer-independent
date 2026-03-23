

# VAT Info Text in Slot Dialog + Global Setting in Booking Settings

## Summary
Replace the per-slot VAT toggle in AddSlotDialog with a read-only info line + link to settings. Add a VAT default card in TrainerBookingSettings with a warning that only new slots are affected.

## Changes

### 1. `src/components/trainer/AddSlotDialog.tsx`

**Add import** at line 1:
```tsx
import { Link } from "react-router-dom";
```

**Replace lines 1019-1032** (the VAT Switch toggle) with:
```tsx
<div className="flex items-center justify-between">
  <p className="text-xs text-muted-foreground">
    {pricesIncludeVat
      ? t("cycles:form.pricesIncludeVat", "Prices include VAT")
      : t("cycles:detail.pricesExcludeVat", "Prices exclude VAT")}
    {" · "}
    <Link 
      to="/app/trainer/settings/bookings" 
      className="text-primary underline hover:text-primary/80"
    >
      {t("calendar.changeInSettings", "Change in settings")}
    </Link>
  </p>
</div>
```

### 2. `src/pages/TrainerBookingSettings.tsx`

- Add `Euro` to lucide imports
- Add `prices_include_vat` to `fetchSettings` query and state
- Add `Alert`, `AlertDescription` imports
- Add new VAT card after the Welcome Message card:

```tsx
<Card>
  <CardHeader>
    <CardTitle className="flex items-center gap-2">
      <Euro className="h-5 w-5 text-primary" />
      {t('bookingSettings.vatTitle')}
    </CardTitle>
    <CardDescription>
      {t('bookingSettings.vatDescription')}
    </CardDescription>
  </CardHeader>
  <CardContent className="space-y-4">
    <div className="flex items-center justify-between p-4 border rounded-lg">
      <div className="flex-1 pr-4">
        <Label htmlFor="vat-toggle" className="font-medium">
          {t('bookingSettings.vatInclLabel')}
        </Label>
        <p className="text-sm text-muted-foreground mt-1">
          {t('bookingSettings.vatInclDescription')}
        </p>
      </div>
      <Switch
        id="vat-toggle"
        checked={pricesIncludeVat}
        onCheckedChange={handleToggleVat}
        disabled={savingVat}
      />
    </div>
    <Alert>
      <AlertDescription className="text-sm text-muted-foreground">
        ⚠️ {t('bookingSettings.vatWarning')}
      </AlertDescription>
    </Alert>
  </CardContent>
</Card>
```

- Add handler `handleToggleVat` that saves to `trainer_profiles.prices_include_vat`
- Add `pricesIncludeVat` and `savingVat` state

### 3. Translation keys

**English (`src/i18n/locales/en/trainer.json`)** — add to `bookingSettings`:
```json
"vatTitle": "VAT Settings",
"vatDescription": "Configure how prices are entered for your sessions",
"vatInclLabel": "Prices include VAT",
"vatInclDescription": "When enabled, prices you enter already include VAT. When disabled, VAT will be added on top.",
"vatWarning": "Changing this setting only affects new slots. Existing slots will keep their current VAT setting."
```

**Add to `calendar`:**
```json
"changeInSettings": "Change in settings"
```

**Dutch (`src/i18n/locales/nl/trainer.json`)** — add to `bookingSettings`:
```json
"vatTitle": "BTW-instellingen",
"vatDescription": "Bepaal hoe prijzen worden ingevoerd voor je sessies",
"vatInclLabel": "Prijzen zijn inclusief BTW",
"vatInclDescription": "Indien ingeschakeld, zijn de prijzen die je invoert inclusief BTW. Indien uitgeschakeld, wordt BTW erbovenop berekend.",
"vatWarning": "Deze wijziging geldt alleen voor nieuwe slots. Bestaande slots behouden hun huidige BTW-instelling."
```

**Add to `calendar`:**
```json
"changeInSettings": "Wijzigen in instellingen"
```

## Files
- `src/components/trainer/AddSlotDialog.tsx` — Replace VAT toggle with info text + link
- `src/pages/TrainerBookingSettings.tsx` — Add VAT settings card with warning
- `src/i18n/locales/en/trainer.json` — Add translation keys
- `src/i18n/locales/nl/trainer.json` — Add translation keys

