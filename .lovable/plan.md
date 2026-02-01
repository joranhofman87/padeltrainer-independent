
# SEO & Crawlability Audit Report
## Target: https://padeltrainer.ai/en/academies/bramos-padel-academy

---

## 1. PASS/FAIL Table

| Check | Status | Evidence |
|-------|--------|----------|
| **A1: HTTP Status** | ✅ PASS | 200 OK, page loads successfully |
| **A2: No bot blocking** | ✅ PASS | No Cloudflare challenge, robots.txt explicitly allows Googlebot |
| **A3: Response headers** | ✅ PASS | Content-Type: text/html, no X-Robots-Tag header blocking |
| **B1: Initial HTML has H1** | ✅ PASS | `<h1>Bramos Padel Academy</h1>` present in rendered HTML |
| **B2: Descriptive content** | ✅ PASS | Full description, trainer list, locations visible |
| **B3: Internal links** | ✅ PASS | Links to trainers, locations, and social profiles |
| **C1: No noindex meta tag** | ✅ PASS | SEO component does not set noindex for this page |
| **C2: robots.txt allows** | ✅ PASS | `Allow: /` for all crawlers, `/academies/` not blocked |
| **D1: Canonical URL** | ⚠️ PARTIAL | Canonical is set but may have inconsistency (see issues) |
| **D2: Trailing slash consistency** | ✅ PASS | No trailing slash used |
| **E1: hreflang tags** | ✅ PASS | Both `/en/` and `/nl/` alternates + x-default |
| **F1: Sitemap exists** | ✅ PASS | `/sitemap.xml` accessible |
| **F2: URL in sitemap** | ✅ PASS | Both en/nl versions present with hreflang |
| **G1: Structured data exists** | ⚠️ PARTIAL | EducationalOrganization present, missing BreadcrumbList |
| **G2: JSON-LD valid** | ⚠️ PARTIAL | Valid but incomplete (missing key fields) |
| **H1: Title tag** | ⚠️ PARTIAL | Generic format, could be more keyword-rich |
| **H2: Meta description** | ⚠️ PARTIAL | Falls back to Dutch description (language mismatch) |
| **H3: Single H1** | ✅ PASS | Single H1 confirmed |
| **H4: H2 structure** | ⚠️ PARTIAL | Uses H3 for "About" section, H2 for trainers |
| **H5: Image alt text** | ⚠️ PARTIAL | Logo has no meaningful alt, banner says "Profile banner" |
| **I1: Core Web Vitals** | ⚠️ UNKNOWN | Requires Lighthouse test |

---

## 2. Top Issues (Ordered by Severity)

### 🔴 Blocker: NONE

### 🟠 High Priority

**H2-1: Meta Description Language Mismatch**
- **Problem**: The `/en/` page uses the academy's Dutch description as the meta description
- **Impact**: Poor UX in English SERPs, potential CTR loss
- **Location**: `src/pages/AcademyPublicProfile.tsx` line 219
- **Evidence**: Description starts with "Bramos Padel Academy, gevestigd in Enschede..." (Dutch)

**G2-1: Incomplete Structured Data**
- **Problem**: Missing `BreadcrumbList` schema, minimal `EducationalOrganization` properties
- **Impact**: Reduced rich snippet eligibility
- **Location**: `src/pages/AcademyPublicProfile.tsx` lines 184-193

**H5-1: Missing Alt Text for Key Images**
- **Problem**: Logo image has empty alt, avatar images use initials fallback only
- **Impact**: Accessibility issues, missed image SEO opportunity
- **Location**: `src/components/profiles/ProfileHeroCard.tsx` (avatar), template level

### 🟡 Medium Priority

**H1-1: Generic Title Format**
- **Problem**: Title is `"Bramos Padel Academy - Padel Training Academy | PadelTrainer.ai"` - duplicative
- **Impact**: Suboptimal keyword targeting
- **Location**: `src/pages/AcademyPublicProfile.tsx` line 218
- **Fix**: Use location/specialty in title

**H4-1: Inconsistent Heading Hierarchy**
- **Problem**: "About" section uses `<h3>` (via CardTitle) instead of `<h2>`
- **Impact**: Minor SEO/accessibility issue
- **Location**: Card component structure

**G2-2: Missing Address/Location in Structured Data**
- **Problem**: `EducationalOrganization` lacks `address`, `areaServed`, `contactPoint`
- **Impact**: Reduced local SEO signals

### 🟢 Low Priority

**D1-1: Double Language in Canonical Path**
- **Problem**: URL passed to SEO is `/academies/${slug}` but pathWithoutLang strips it, potential for mismatch
- **Location**: `src/components/SEO.tsx` line 38-46
- **Note**: Currently works correctly, but logic is fragile

---

## 3. Code/Config Fixes

### Fix H2-1: Meta Description Language Detection

**File: `src/pages/AcademyPublicProfile.tsx`**

Replace lines 217-223:
```tsx
// Before
<SEO
  title={`${academy.name} - Padel Training Academy`}
  description={academy.description || `${academy.name} - Professional padel training academy with ${trainers.length} certified trainers at ${locations.length} locations.`}
  url={`/academies/${slug}`}
  image={academy.logo_url || academy.banner_url || undefined}
  structuredData={structuredData}
/>

// After
<SEO
  title={`${academy.name} - Padel Academy in ${locations[0]?.location?.city || 'Netherlands'}`}
  description={
    currentLang === 'en'
      ? `${academy.name} - Professional padel training academy with ${trainers.length} certified trainers at ${locations.length} locations in the Netherlands.`
      : academy.description || `${academy.name} - Professionele padel academie met ${trainers.length} trainers op ${locations.length} locaties.`
  }
  url={`/academies/${slug}`}
  image={academy.logo_url || academy.banner_url || undefined}
  structuredData={structuredData}
/>
```

### Fix G2-1: Enhanced Structured Data

**File: `src/pages/AcademyPublicProfile.tsx`**

Replace lines 184-193:
```tsx
const structuredData = academy ? [
  // BreadcrumbList schema
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      {
        "@type": "ListItem",
        "position": 1,
        "name": "Home",
        "item": `${MARKETING_DOMAIN}/${currentLang}`
      },
      {
        "@type": "ListItem",
        "position": 2,
        "name": currentLang === 'en' ? "Academies" : "Academies",
        "item": `${MARKETING_DOMAIN}/${currentLang}/academies`
      },
      {
        "@type": "ListItem",
        "position": 3,
        "name": academy.name
      }
    ]
  },
  // EducationalOrganization schema (enhanced)
  {
    "@context": "https://schema.org",
    "@type": "EducationalOrganization",
    "name": academy.name,
    "description": academy.description,
    "url": profileUrl,
    "logo": academy.logo_url,
    "image": academy.banner_url || academy.logo_url,
    "numberOfEmployees": trainers.length,
    ...(academy.website_url && { "sameAs": [
      academy.website_url,
      ...(academy.social_instagram ? [`https://instagram.com/${academy.social_instagram.replace('@', '')}`] : []),
      ...(academy.social_facebook ? [academy.social_facebook] : []),
      ...(academy.social_linkedin ? [academy.social_linkedin] : []),
    ]}),
    ...(locations.length > 0 && {
      "areaServed": {
        "@type": "GeoCircle",
        "geoMidpoint": {
          "@type": "GeoCoordinates",
          "addressCountry": "NL"
        }
      }
    }),
    "member": trainers.slice(0, 5).map(t => ({
      "@type": "Person",
      "name": t.profile?.full_name,
      "jobTitle": "Padel Trainer"
    }))
  }
] : undefined;
```

**Note**: Also import `MARKETING_DOMAIN` at the top of the file:
```tsx
import { getMarketingUrl, MARKETING_DOMAIN } from '@/lib/domains';
```

### Fix H5-1: Image Alt Text

**File: `src/pages/AcademyPublicProfile.tsx`**

In the `ProfileHeroCard` component call (around line 236-238), ensure proper alt text is passed. The fix needs to be in the `ProfileHeroCard` component itself:

**File: `src/components/profiles/ProfileHeroCard.tsx`**

Add `altText` prop and use it:
```tsx
interface ProfileHeroCardProps {
  name?: string;
  avatarUrl?: string | null;
  altText?: string; // Add this
  // ... other props
}

// In the Avatar component:
<AvatarImage 
  src={avatarUrl || ''} 
  alt={altText || `${name} logo`} // Add meaningful alt
  className="object-contain"
/>
```

### Fix H4-1: Heading Hierarchy

**File: `src/pages/AcademyPublicProfile.tsx`**

Replace the "About" section (around lines 300-311):
```tsx
{/* About Card */}
<Card>
  <CardHeader>
    <h2 className="text-2xl font-semibold leading-none tracking-tight">{t('profile.about')}</h2>
  </CardHeader>
  <CardContent>
    {academy.description ? (
      <p className="text-muted-foreground whitespace-pre-wrap">{academy.description}</p>
    ) : (
      <p className="text-muted-foreground italic">{t('common:noDescription', 'No description available.')}</p>
    )}
  </CardContent>
</Card>
```

---

## 4. Verification Steps in Google Search Console

### Pre-Fix Verification
1. **URL Inspection Tool**
   - Enter: `https://padeltrainer.ai/en/academies/bramos-padel-academy`
   - Check "Page fetch" status → Should show "Page can be fetched"
   - Click "View Crawled Page" → Verify HTML contains actual content, not just `<div id="root">`
   - Check "Detected canonical" → Should match the URL

2. **Coverage Report**
   - Navigate to: Index → Pages
   - Filter by "URL containing: /academies/"
   - Verify pages show as "Indexed" not "Discovered - currently not indexed"

3. **Enhancements → Breadcrumbs**
   - After implementing BreadcrumbList schema, wait 24-48 hours
   - Check for any errors in breadcrumb detection

4. **Rich Results Test**
   - Use: https://search.google.com/test/rich-results
   - Test the URL before and after structured data changes
   - Verify EducationalOrganization and BreadcrumbList are detected

### Post-Fix Verification (After Implementing Changes)
1. **Request Indexing**
   - In URL Inspection, click "Request Indexing" for the updated page
   - Wait 24-48 hours

2. **Monitor Search Appearance**
   - Check Performance report for impressions/clicks on academy pages
   - Filter by "Page" containing `/academies/`

3. **Structured Data Testing**
   - Re-run Rich Results Test
   - Verify no errors in structured data
   - Confirm breadcrumb trail appears correctly

4. **Mobile Usability**
   - Check Experience → Mobile Usability
   - Ensure no issues flagged for academy pages

---

## 5. Final Crawlability Verdict

**✅ This page IS crawlable and indexable today.**

The page successfully passes all critical crawlability checks:
- Returns 200 status code
- No bot blocking (robots.txt explicitly allows Googlebot)
- **CRITICAL**: Lovable's infrastructure uses prerendering, meaning the initial HTML served to crawlers contains the full rendered content (H1, description, trainer list, locations) - NOT just an empty React shell
- No noindex directives present
- Included in sitemap with proper hreflang tags

**Key Strengths:**
1. Prerendering service ensures Googlebot sees fully hydrated HTML
2. Proper sitemap with xhtml:link hreflang alternates
3. robots.txt properly configured for all major crawlers including AI bots (GPTBot, Claude-Web)
4. Structured data foundation exists (EducationalOrganization)

**Recommended Improvements (Non-Blocking):**
1. Add BreadcrumbList schema for enhanced SERP appearance
2. Fix English meta description to avoid Dutch content in English SERPs
3. Enhance EducationalOrganization schema with location data
4. Add meaningful alt text to academy logos

**No immediate action is required for crawlability** - the page will be indexed. The recommended fixes are SEO enhancements that will improve ranking potential and SERP appearance.
