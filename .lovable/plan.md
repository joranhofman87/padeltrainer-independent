

# Trigger GitHub Sync

Make a trivial comment change to any file to force Lovable to push all pending changes (including the sitemap workflow fix) to GitHub.

## Change

**`.github/workflows/sitemap.yml`** — Add a comment to the top of the file:

```yaml
# Sitemap generation workflow - syncs weekly
name: Regenerate Sitemap
```

This is a no-op change that will trigger Lovable's auto-sync, pushing the updated workflow file (with the loop fix and pagination optimization) to your GitHub repository.

After the sync completes, cancel any currently running sitemap workflow on GitHub and re-trigger it manually.

