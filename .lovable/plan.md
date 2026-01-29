

# Plan: Scheduled Sitemap Regeneration

## Overview

Set up automated daily regeneration of the sitemap using GitHub Actions. This ensures the sitemap stays fresh as you add new academies, clubs, and trainers, while keeping the sitemap file on your primary domain for optimal SEO.

## How It Works

```text
+------------------+     +----------------------+     +-------------------+
|  GitHub Actions  | --> |  Sitemap Edge        | --> |  public/sitemap.xml |
|  (Daily @ 6 AM)  |     |  Function            |     |  (committed)        |
+------------------+     +----------------------+     +-------------------+
         |                         |                           |
         |  1. Runs script         |  2. Fetches fresh data    |  3. Committed back
         |                         |     from database          |     to repository
         v                         v                           v
    Scheduled trigger      Trainers, Locations,         Served at
    (cron: 0 6 * * *)      Academies, Cities           padeltrainer.ai/sitemap.xml
```

## Implementation

### 1. Create GitHub Actions Workflow

**New File:** `.github/workflows/sitemap.yml`

This workflow will:
- Run daily at 6:00 AM UTC
- Allow manual triggering for immediate regeneration
- Fetch the latest sitemap from the edge function
- Commit and push the updated file if there are changes

### 2. Add npm Script for Sitemap Generation

**File:** `package.json`

Add a convenient script to run the sitemap generator:
```json
"scripts": {
  "sitemap": "npx tsx scripts/generate-sitemap.ts"
}
```

## Workflow Configuration

```yaml
name: Regenerate Sitemap

on:
  schedule:
    # Run daily at 6:00 AM UTC
    - cron: '0 6 * * *'
  workflow_dispatch:
    # Allow manual triggering

jobs:
  regenerate-sitemap:
    runs-on: ubuntu-latest
    permissions:
      contents: write

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Generate sitemap
        run: npx tsx scripts/generate-sitemap.ts

      - name: Commit and push if changed
        run: |
          git config user.name 'github-actions[bot]'
          git config user.email 'github-actions[bot]@users.noreply.github.com'
          git add public/sitemap.xml
          git diff --staged --quiet || git commit -m "chore: regenerate sitemap [skip ci]"
          git push
```

## Key Features

| Feature | Description |
|---------|-------------|
| **Daily schedule** | Runs every day at 6 AM UTC automatically |
| **Manual trigger** | Can be run anytime from GitHub Actions UI |
| **Smart commits** | Only commits if sitemap actually changed |
| **Skip CI** | Uses `[skip ci]` to avoid triggering other workflows |
| **Permissions** | Uses `contents: write` for pushing changes |

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `.github/workflows/sitemap.yml` | Create | New workflow for scheduled regeneration |
| `package.json` | Modify | Add `sitemap` script for convenience |

## Schedule Options

The default is daily at 6 AM UTC. You can adjust the cron expression:

| Schedule | Cron Expression |
|----------|-----------------|
| Daily at 6 AM UTC | `0 6 * * *` |
| Twice daily (6 AM & 6 PM) | `0 6,18 * * *` |
| Every 6 hours | `0 */6 * * *` |
| Weekly (Sundays at 6 AM) | `0 6 * * 0` |

## Manual Regeneration

You can still regenerate manually anytime:
- **GitHub Actions UI**: Go to Actions → Regenerate Sitemap → Run workflow
- **Local command**: `npm run sitemap` or `npx tsx scripts/generate-sitemap.ts`

## Expected Outcome

After implementation:
- Sitemap automatically updates daily with all new trainers, locations, academies, and clubs
- No manual intervention required
- Sitemap remains at `padeltrainer.ai/sitemap.xml` (optimal for SEO)
- Changes are tracked in git history

