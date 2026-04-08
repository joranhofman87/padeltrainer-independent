

# Red Flag Quiz Text Improvements

## Changes

### 1. Remove all em dashes across 6 language files

**English (`en/marketing.json`)** — every em dash instance:

| Line | Current | Replacement |
|---|---|---|
| 1198 | `Fun Quiz — PadelTrainer.ai` | `Fun Quiz \| PadelTrainer.ai` |
| 1199 | `yours — and challenge` | `yours, and challenge` |
| 1219 | `say nothing — you'll remember` | `say nothing. You'll remember` |
| 1221 | `right back at them — eye for an eye` | `right back at them. Eye for an eye` |
| 1227 | `fresh overgrip — looking sponsored` | `fresh overgrip. Looking sponsored` |
| 1300 | `can't help it — you see` | `can't help it. You see` |
| 1311 | `win or lose — gets a` | `win or lose, gets a` |
| 1376 | `Wait — sorry again` | `Wait... sorry again` |

**Other 5 languages** — find and replace all em dashes with equivalent natural punctuation (period, comma, or ellipsis as appropriate per context).

### 2. Replace Question 1 content + mapping

**`en/marketing.json`** — replace `q1` block:
```json
"q1": {
  "title": "The Coaching Moment",
  "scenario": "Mid-match, your partner keeps making the same mistake. You...",
  "a": "Say nothing, but mentally add it to the list of things they do wrong",
  "b": "Stop the game and explain exactly what they should be doing instead",
  "c": "Just focus on your own game, you're here to win",
  "d": "Yell \"VAMOS!\" louder to make up for the lost points"
}
```

**`src/lib/redFlagQuizData.ts`** — update Q1 option C mapping from `blame-shifter` to `blame-shifter` (keeping it, since "focus on winning" fits the competitive/blame-shifting personality). The other mappings stay: A→silent-grudge-holder, B→sideline-coach, D→vamos-spammer.

**Other 5 languages** — translate the new Q1 to match.

### 3. File summary

| File | Change |
|---|---|
| `src/i18n/locales/en/marketing.json` | Remove em dashes, replace Q1 |
| `src/i18n/locales/es/marketing.json` | Remove em dashes, translate new Q1 |
| `src/i18n/locales/nl/marketing.json` | Remove em dashes, translate new Q1 |
| `src/i18n/locales/de/marketing.json` | Remove em dashes, translate new Q1 |
| `src/i18n/locales/fr/marketing.json` | Remove em dashes, translate new Q1 |
| `src/i18n/locales/it/marketing.json` | Remove em dashes, translate new Q1 |
| `src/lib/redFlagQuizData.ts` | No change needed (Q1 mappings already correct) |

