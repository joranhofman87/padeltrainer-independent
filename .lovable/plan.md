

## Fix: Homepage SEO Title

### Problem
The homepage `<title>` tag shows **"Find Your Perfect | PadelTrainer.ai"** instead of **"Find Your Perfect Padel Trainer | PadelTrainer.ai"**.

This happens because line 147 in `src/pages/marketing/Home.tsx` only uses `t('home.hero.title')` ("Find Your Perfect") without including `t('home.hero.titleHighlight')` ("Padel Trainer").

### Fix
Change line 147 in `src/pages/marketing/Home.tsx` from:

```tsx
title={t('home.hero.title')}
```

to:

```tsx
title={`${t('home.hero.title')} ${t('home.hero.titleHighlight')}`}
```

This produces:
- **EN:** "Find Your Perfect Padel Trainer | PadelTrainer.ai"
- **NL:** "Vind jouw perfecte Padeltrainer | PadelTrainer.ai"

### Scope
One line change in one file. No other files affected.
