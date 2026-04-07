

# Optimize GitHub Actions Sitemap Workflow

## Problem

The sitemap workflow runs **daily**, and every commit it pushes triggers a Lovable sync and rebuild — consuming credits even when content hasn't meaningfully changed. With sitemaps, weekly regeneration is the industry standard.

## Changes

### `.github/workflows/sitemap.yml`

1. **Change schedule from daily to weekly** — run every Monday at 6:00 AM UTC instead of every day
2. **Keep `workflow_dispatch`** so you can manually trigger it anytime you publish a batch of new content

```yaml
on:
  schedule:
    - cron: '0 6 * * 1'  # Every Monday at 6:00 AM UTC
  workflow_dispatch:
```

That's it — one line change. This cuts your GitHub Actions usage by ~85% (from 365 runs/year to 52).

## Impact

- Sitemaps still update regularly enough for Google (weekly is standard practice)
- You can always trigger manually after a big content push
- Saves ~6 workflow runs per week worth of GitHub Actions minutes and Lovable rebuild credits

