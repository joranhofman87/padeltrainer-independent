

# Update Hero Headline Text & Size

## Changes

### 1. Translation files — update `homev2.hero.h1`
- **English**: `"You coach. We handle the rest."`
- **Dutch**: `"Jij coacht. Wij regelen de rest."`
- **German**: `"Du coachst. Wir erledigen den Rest."`
- **Spanish**: `"Tú entrenas. Nosotros nos encargamos del resto."`
- **French**: `"Vous coachez. On s'occupe du reste."`

### 2. `src/components/home/HeroSection.tsx` — reduce font size
Current: `text-4xl md:text-5xl lg:text-7xl` (line 230)
Change to: `text-3xl md:text-4xl lg:text-5xl` — shorter text, tighter heading, cleaner look.

## Files Changed

| File | Change |
|------|--------|
| `src/i18n/locales/en/marketing.json` | Update h1 text |
| `src/i18n/locales/nl/marketing.json` | Update h1 text |
| `src/i18n/locales/de/marketing.json` | Update h1 text |
| `src/i18n/locales/es/marketing.json` | Update h1 text |
| `src/i18n/locales/fr/marketing.json` | Update h1 text |
| `src/components/home/HeroSection.tsx` | Reduce h1 font size classes |

