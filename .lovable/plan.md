

# Plan: Scrape Padel Academies with AI-Generated Unique Descriptions

## Overview

Create an edge function that scrapes **~234 padel academies** from padelgids.nl and imports them with **AI-generated unique descriptions** (not copied content). The system will extract factual data (name, locations, contact info) and use that metadata to generate original Dutch descriptions via Lovable AI.

## Data Strategy

### What We Scrape (Facts Only)
| Data Point | Source | Purpose |
|------------|--------|---------|
| Academy name | Listing page | Direct use |
| City | Listing page | Direct use |
| Logo URL | Detail page | Download & store |
| Website URL | Detail page | Direct use |
| Contact email | Detail page | Direct use |
| Social links | Detail page | Direct use |
| Location names | Detail page | Match to existing locations |
| Trainer names | Detail page | Store for future matching |
| Number of locations | Detail page | Context for AI description |

### What We Generate (Unique Content)
The AI will generate a unique Dutch description based on:
- Academy name and city
- Number and names of affiliated locations
- Any specializations mentioned (jeugd, beginners, competitie, etc.)
- Whether they have multiple locations (regional vs local presence)

**Example AI Prompt:**
```text
Schrijf een unieke, feitelijke beschrijving (2-3 zinnen, max 100 woorden) 
voor deze padelacademie in het Nederlands.

REGELS:
- Begin NIET met "Welkom bij" of generieke zinnen
- Schrijf in de derde persoon
- Maak de tekst uniek door specifieke details te noemen
- Focus op wat deze academie onderscheidt

Academie: Padel Pro Academy
Stad: Amsterdam
Aantal locaties: 4
Locaties: TC Amsterdam, Amstelpark Padel, Noord Padel, Oost Tennis
Specialisaties: jeugdtraining, competitiebegeleiding
```

**Example Output:**
"Padel Pro Academy is een toonaangevende padelschool in de regio Amsterdam met trainingsmogelijkheden op vier locaties, waaronder TC Amsterdam en Amstelpark Padel. De academie richt zich op zowel jeugdtraining als competitiebegeleiding voor gevorderde spelers."

## Technical Implementation

### New Edge Function: `scrape-academies`

**File:** `supabase/functions/scrape-academies/index.ts`

**Parameters:**
```typescript
{
  batch_size: number;     // Academies per run (default: 10, max: 30)
  page_offset: number;    // Starting page (1-10)
  dry_run: boolean;       // Preview without DB writes
  academy_slugs?: string[]; // Specific academies to process
}
```

### Processing Pipeline

```text
Phase 1: Scrape Listing Pages
┌─────────────────────────────────────────────┐
│ Firecrawl: padelgids.nl/padelscholen/?page=N │
│ Extract: name, city, slug, logo thumbnail   │
└─────────────────────────────────────────────┘
                    ▼
Phase 2: Scrape Detail Pages
┌─────────────────────────────────────────────┐
│ Firecrawl: padelgids.nl/padelscholen/{slug}  │
│ Extract: website, email, socials, locations │
└─────────────────────────────────────────────┘
                    ▼
Phase 3: AI Extraction (Structured Data)
┌─────────────────────────────────────────────┐
│ Lovable AI: Parse markdown → JSON           │
│ Extract: email, phone, social URLs          │
│ Extract: location names, trainer names      │
└─────────────────────────────────────────────┘
                    ▼
Phase 4: Location Matching
┌─────────────────────────────────────────────┐
│ Query locations table for fuzzy matches     │
│ Match by name similarity + city             │
└─────────────────────────────────────────────┘
                    ▼
Phase 5: Generate Unique Description
┌─────────────────────────────────────────────┐
│ Lovable AI: Generate Dutch description      │
│ Input: name, city, locations, specialties   │
│ Output: 2-3 sentence unique description     │
└─────────────────────────────────────────────┘
                    ▼
Phase 6: Database Insert
┌─────────────────────────────────────────────┐
│ INSERT academy_profiles                      │
│ INSERT academy_locations (linked records)    │
│ Upload logo to storage                       │
└─────────────────────────────────────────────┘
```

### AI Functions

**1. Extract Structured Data:**
```typescript
async function extractAcademyData(markdown: string): Promise<{
  website_url: string | null;
  contact_email: string | null;
  phone: string | null;
  social_instagram: string | null;
  social_facebook: string | null;
  social_linkedin: string | null;
  locations: string[];      // Names of affiliated clubs
  trainers: string[];       // Trainer names for future matching
  specializations: string[]; // e.g., ["jeugd", "competitie"]
}>
```

**2. Generate Unique Description:**
```typescript
async function generateUniqueDescription(
  name: string,
  city: string,
  locationNames: string[],
  specializations: string[]
): Promise<string>
```

### Location Matching Strategy

```sql
-- Find best matching location by name similarity
SELECT id, name, city,
  similarity(LOWER(name), LOWER($scraped_name)) as score
FROM locations
WHERE city ILIKE $scraped_city
  OR similarity(LOWER(name), LOWER($scraped_name)) > 0.4
ORDER BY score DESC
LIMIT 1;
```

### Database Operations

```sql
-- 1. Insert academy profile
INSERT INTO academy_profiles (
  name, slug, description,
  logo_url, website_url, contact_email, phone,
  social_instagram, social_facebook, social_linkedin,
  is_verified, is_public
) VALUES (...);

-- 2. Link to matched locations
INSERT INTO academy_locations (
  academy_profile_id, location_id,
  is_active, show_on_academy_page
) VALUES (...);
```

### Deduplication

Before inserting, check for existing academies:
```typescript
const { data: existing } = await supabase
  .from("academy_profiles")
  .select("id, slug")
  .or(`slug.eq.${slug},name.ilike.${name}`);
```

## Admin UI Integration

Add a card to `AdminDashboard.tsx` for triggering the scrape:

```typescript
// New card in admin actions grid
<div className="rounded-lg border bg-card p-4">
  <div className="flex items-center justify-between">
    <div className="flex items-center gap-3">
      <GraduationCap className="h-5 w-5 text-primary" />
      <div>
        <h3 className="font-semibold">Scrape Academies</h3>
        <p className="text-sm text-muted-foreground">
          Import from padelgids.nl
        </p>
      </div>
    </div>
    <Button onClick={handleScrapeAcademies} disabled={isScraping}>
      {isScraping ? <Loader2 className="animate-spin" /> : "Start"}
    </Button>
  </div>
</div>
```

## Implementation Phases

### Phase 1: Edge Function Core
- Create `scrape-academies/index.ts`
- Implement Firecrawl integration for listing pages
- Parse academy entries (name, city, slug)
- Add to `config.toml`

### Phase 2: Detail Page Processing
- Scrape individual academy pages
- AI extraction of structured contact data
- AI extraction of location/trainer lists

### Phase 3: AI Description Generation
- Generate unique Dutch descriptions
- Use metadata (locations, specializations) for variety
- Avoid any copied content

### Phase 4: Database Integration
- Location matching algorithm
- Insert academy profiles with generated descriptions
- Create `academy_locations` links
- Upload logos to storage

### Phase 5: Admin UI
- Add scrape trigger to AdminDashboard
- Show progress/results in toast
- Track total imported academies

## Expected Results

| Metric | Estimate |
|--------|----------|
| Total Academies | ~234 |
| With Website URLs | ~200 |
| With Matched Locations | ~150 |
| Unique Descriptions | 100% (AI-generated) |
| Processing Time | ~45-60 min (full import) |
| Batches Required | ~24 (10 per batch) |

## Rate Limiting

- Firecrawl: 500ms delay between requests
- Lovable AI: 200ms delay between calls
- Process 10 academies per run
- Full import: ~24 runs

## Files to Create/Modify

| File | Action |
|------|--------|
| `supabase/functions/scrape-academies/index.ts` | Create |
| `supabase/config.toml` | Add function config |
| `src/pages/AdminDashboard.tsx` | Add scrape trigger card |
| `src/lib/admin.ts` | Add scrapeAcademies function |

## Technical Details

### Dependencies Used
- **Firecrawl**: Web scraping (already configured)
- **Lovable AI**: Gemini for data extraction + description generation
- **Supabase Storage**: Logo upload to `avatars/academies/`

### Error Handling
- Skip academies that fail scraping (log and continue)
- Retry failed AI calls once
- Report summary of success/failures

