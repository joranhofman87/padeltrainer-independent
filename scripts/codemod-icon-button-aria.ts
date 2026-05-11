#!/usr/bin/env bun
/**
 * Codemod: add aria-label to icon-only Buttons matching common patterns.
 *
 * Conservative regex-based pass — we add aria-label only when:
 *   - The match clearly identifies the intent (back/prev/next/close/more/add/remove/delete).
 *   - There is no existing aria-label / aria-labelledby on the element.
 *
 * We use literal English strings (not t('...')) because:
 *   - 60%+ of the touched files already mix t() and literals.
 *   - Adding the t() import here would require parsing imports per-file.
 *   - Translators can substitute via the existing parity check.
 * Marketing/public flows that need translated aria-labels can be upgraded
 * individually in follow-up PRs; this just kills the screen-reader silence.
 */

import { Glob } from "bun";
import { readFileSync, writeFileSync } from "fs";

const ICON_RE = /<Button\b([^>]*?)\bsize=["']icon["']([^>]*?)>([\s\S]*?)<\/Button>/g;

type Pattern = {
  test: (innerJsx: string, attrs: string, fullMatch: string) => string | null;
};

const has = (s: string, re: RegExp) => re.test(s);

const patterns: Pattern[] = [
  // Back arrows — also recognize navigate(-1) / navigate('/...')
  {
    test: (inner, attrs, full) => {
      if (has(inner, /\bArrowLeft\b/) || /onClick=\{\(\)\s*=>\s*navigate\(-1\)\}/.test(full) ||
          /handleBack\b/.test(full)) {
        return "Go back";
      }
      return null;
    },
  },
  // Calendar / pagination chevrons
  {
    test: (inner) => {
      if (/\bChevronLeft\b/.test(inner)) return "Previous";
      if (/\bChevronRight\b/.test(inner)) return "Next";
      return null;
    },
  },
  // Close
  {
    test: (inner) => (/<X\b|XIcon|XCircle/.test(inner) ? "Close" : null),
  },
  // Action menus
  {
    test: (inner) =>
      /\bMoreVertical\b|\bMoreHorizontal\b/.test(inner) ? "Open actions menu" : null,
  },
  // Add / remove / delete row
  {
    test: (inner) => {
      if (/\bTrash2?\b/.test(inner)) return "Delete";
      if (/\bMinus\b/.test(inner)) return "Remove";
      if (/\bPlus\b/.test(inner)) return "Add";
      return null;
    },
  },
  // Edit / settings
  {
    test: (inner) => {
      if (/\bPencil\b|\bEdit2?\b/.test(inner)) return "Edit";
      if (/\bSettings\b/.test(inner)) return "Settings";
      if (/\bCopy\b/.test(inner)) return "Copy";
      if (/\bDownload\b/.test(inner)) return "Download";
      if (/\bExternalLink\b/.test(inner)) return "Open in new tab";
      if (/\bRefreshC(w|cw)\b|\bRefresh\b/.test(inner)) return "Refresh";
      if (/\bSearch\b/.test(inner)) return "Search";
      if (/\bFilter\b/.test(inner)) return "Filter";
      return null;
    },
  },
];

function alreadyLabeled(attrs: string) {
  return /\baria-label\s*=|\baria-labelledby\s*=|\btitle\s*=/.test(attrs);
}

let totalChanged = 0;
let totalSkipped = 0;
const changedFiles: string[] = [];

const glob = new Glob("src/**/*.tsx");
for await (const file of glob.scan(".")) {
  const src = readFileSync(file, "utf8");
  let dirty = false;

  const out = src.replace(ICON_RE, (full, attrsBefore: string, attrsAfter: string, inner: string) => {
    const allAttrs = attrsBefore + attrsAfter;
    if (alreadyLabeled(allAttrs)) return full;

    let label: string | null = null;
    for (const p of patterns) {
      label = p.test(inner, allAttrs, full);
      if (label) break;
    }
    if (!label) {
      totalSkipped++;
      return full;
    }
    totalChanged++;
    dirty = true;
    // Insert aria-label right after `size="icon"`.
    return full.replace(
      /size=["']icon["']/,
      `size="icon" aria-label="${label}"`
    );
  });

  if (dirty) {
    writeFileSync(file, out);
    changedFiles.push(file);
  }
}

console.log(`Codemod complete: labeled ${totalChanged} buttons across ${changedFiles.length} file(s); ${totalSkipped} icon-buttons left for manual review.`);
