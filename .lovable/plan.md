## Resolve flagged npm vulnerabilities

A fresh dependency scan reports **no high or critical vulnerabilities**, so the protobufjs / minimatch / picomatch advisories from the audit appear to already be resolved in the current lockfile (likely fixed by earlier dependency updates).

### Plan

1. Run `bun audit` (or `npm audit --json`) inside the sandbox to get an authoritative current list of advisories with severities and affected paths.
2. If anything high/critical remains:
   - Prefer `bun update <pkg>` (or transitive overrides via `package.json` `"overrides"`) to bump only the vulnerable packages.
   - Re-run the audit to confirm clean.
3. If only moderates remain (typical for transitive dev-only deps), document which ones and whether a fix requires a breaking major bump — surface that to you before touching it.
4. Report the final audit result.

### Out of scope
- Major version upgrades of direct dependencies (React, Vite, etc.) unless required to clear a critical CVE.
- Touching unrelated packages.