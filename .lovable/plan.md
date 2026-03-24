

# Fix Dutch Title Case → Sentence Case Across All Translation Files

## Problem
Dutch translations throughout the app use English-style title case (capitalizing every word), e.g. "Open voor Inschrijving", "Cyclus Aanmaken", "Trainer Dashboard". In Dutch, only the first word of a phrase should be capitalized (sentence case), e.g. "Open voor inschrijving", "Cyclus aanmaken", "Trainer dashboard". English translations should remain unchanged.

## Scope
All 11 Dutch translation files need corrections. This is a text-only change — no logic or component changes needed.

## Files and key corrections

### `src/i18n/locales/nl/common.json`
~50 fixes including:
- "Wissel Profiel" → "Wissel profiel", "Mijn Clubs" → "Mijn clubs", "Trainer Dashboard" → "Trainer dashboard"
- "Padel Locaties" → "Padel locaties", "Boek Sessie" → "Boek sessie", "Bekijk Profiel" → "Bekijk profiel"
- "Pagina Niet Gevonden" → "Pagina niet gevonden", "Account Verwijderen" → "Account verwijderen"
- "Vind Padel Academies" → "Vind padel academies", "Uitgelichte Trainers" → "Uitgelichte trainers"
- "Favoriete Padelclubs" → "Favoriete padelclubs", "Aankomende Toernooien" → "Aankomende toernooien"

### `src/i18n/locales/nl/cycles.json`
~40 fixes including:
- "Open voor Inschrijving" → "Open voor inschrijving", "Inschrijving Niet Gevonden" → "Inschrijving niet gevonden"
- "Cyclus Aanmaken" → "Cyclus aanmaken", "Cyclus Naam" → "Cyclusnaam"
- "Aangeboden Lesvormen" → "Aangeboden lesvormen", "Max Groepsgrootte" → "Max groepsgrootte"
- "Persoonlijke Informatie" → "Persoonlijke informatie", "Aanmelding Ingediend!" → "Aanmelding ingediend!"
- "Voorgestelde Toewijzingen" → "Voorgestelde toewijzingen", "Alle Voorstellen Genereren" → "Alle voorstellen genereren"
- "Trainingen Per Week" → "Trainingen per week", "Aanmelding Ontvangen" → "Aanmelding ontvangen"

### `src/i18n/locales/nl/academy.json`
~60 fixes including:
- "Academy Dashboard" → "Academy dashboard", "Bekijk Publiek Profiel" → "Bekijk publiek profiel"
- "Academy Trainers" → "Academy trainers", "Trainers Beheren" → "Trainers beheren"
- "Trainer Uitnodigen" → "Trainer uitnodigen", "Locatie Toevoegen" → "Locatie toevoegen"
- "Factuur Instellingen" → "Factuurinstellingen", "Wijzigingen Opslaan" → "Wijzigingen opslaan"
- "Wachtlijst Inschakelen" → "Wachtlijst inschakelen"

### `src/i18n/locales/nl/trainer.json`
~80 fixes including:
- "Mijn Profiel" → "Mijn profiel", "Alle Spelers" → "Alle spelers"
- "Profiel Delen" → "Profiel delen", "Link Kopiëren" → "Link kopiëren"
- "Nieuwe Sessie Aanmaken" → "Nieuwe sessie aanmaken", "Slot Toevoegen" → "Slot toevoegen"
- "Speler Toevoegen" → "Speler toevoegen", "Cyclus Aanmaken" → "Cyclus aanmaken"
- "Totale Inkomsten" → "Totale inkomsten", "Huidig Plan" → "Huidig plan"
- "Factuur Instellingen" → "Factuurinstellingen"

### `src/i18n/locales/nl/player.json`
~30 fixes including:
- "Profiel Bewerken" → "Profiel bewerken", "Kalender Sync" → "Kalender sync"
- "Volledige Naam" → "Volledige naam", "Wijzigingen Opslaan" → "Wijzigingen opslaan"
- "Vind Trainers" → "Vind trainers", "Mijn Boekingen" → "Mijn boekingen"
- "Boeking Bevestigd!" → "Boeking bevestigd!", "Boeking Annuleren" → "Boeking annuleren"

### `src/i18n/locales/nl/club.json`
~40 fixes including:
- "Club Dashboard" → "Club dashboard", "Clubtrainer Uitnodiging" → "Clubtrainer uitnodiging"
- "Trainer Aanmaken" → "Trainer aanmaken", "Speler Toevoegen" → "Speler toevoegen"
- "Club Abonnement" → "Club abonnement", "Toernooi Aanmaken" → "Toernooi aanmaken"

### `src/i18n/locales/nl/auth.json`
~15 fixes including:
- "Wachtwoord Resetten" → "Wachtwoord resetten", "Nieuw Wachtwoord Instellen" → "Nieuw wachtwoord instellen"
- "Wachtwoord Bijwerken" → "Wachtwoord bijwerken", "Account Aanmaken" → "Account aanmaken"

### `src/i18n/locales/nl/admin.json`
~10 fixes including:
- "Toegang Geweigerd" → "Toegang geweigerd", "Locaties Importeren" → "Locaties importeren"

### `src/i18n/locales/nl/marketing.json`
~15 fixes including:
- "Vind Padeltrainers" → "Vind padeltrainers", "Algemene Voorwaarden" → "Algemene voorwaarden"
- "Geverifieerde Trainers" → "Geverifieerde trainers", "Makkelijk Boeken" → "Makkelijk boeken"

### `src/i18n/locales/nl/waitingList.json`
Already mostly correct — minimal changes needed.

### `src/i18n/locales/nl/notifications.json`
Already correct — no changes needed.

## Rules applied
- Only lowercase the second+ words in multi-word phrases
- Keep proper nouns capitalized: "Mollie", "KNLTB", "Google", "PadelTrainer.ai", "Padel" (brand), "WhatsApp"
- Keep "Academy" as-is when used as a proper noun/brand name for the feature
- Don't change single-word translations
- Don't change English files

