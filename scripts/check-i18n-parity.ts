#!/usr/bin/env bun
/**
 * i18n parity check.
 *
 * Compares every non-`en` locale under src/i18n/locales/ against `en` and
 * fails if any keys are missing. Run via `bun run i18n:check` or in CI.
 *
 * Output is capped per-locale to keep CI logs readable. Exit code is 1 when
 * any locale has missing keys, 0 otherwise. Extra keys (present in a locale
 * but not in en) are reported as warnings only and do not fail the run.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "src", "i18n", "locales");
const REFERENCE = "en";
const MAX_REPORT = 25;

function flatten(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") return [prefix];
  if (Array.isArray(obj)) return [prefix];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out.push(...flatten(v, next));
    } else {
      out.push(next);
    }
  }
  return out;
}

function loadLocale(locale: string): Map<string, Set<string>> {
  const dir = join(ROOT, locale);
  const result = new Map<string, Set<string>>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const ns = file.replace(/\.json$/, "");
    const raw = readFileSync(join(dir, file), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error(`Invalid JSON in ${locale}/${file}:`, (e as Error).message);
      process.exit(2);
    }
    result.set(ns, new Set(flatten(parsed)));
  }
  return result;
}

const locales = readdirSync(ROOT).filter((f) =>
  statSync(join(ROOT, f)).isDirectory(),
);
if (!locales.includes(REFERENCE)) {
  console.error(`Reference locale "${REFERENCE}" missing.`);
  process.exit(2);
}

const reference = loadLocale(REFERENCE);
const others = locales.filter((l) => l !== REFERENCE).sort();

let failed = false;
const summary: string[] = [];

for (const locale of others) {
  const target = loadLocale(locale);
  const missing: string[] = [];
  const extraNs: string[] = [];

  for (const [ns, keys] of reference) {
    const targetKeys = target.get(ns);
    if (!targetKeys) {
      for (const k of keys) missing.push(`${ns}:${k}`);
      continue;
    }
    for (const k of keys) {
      if (!targetKeys.has(k)) missing.push(`${ns}:${k}`);
    }
  }
  for (const ns of target.keys()) {
    if (!reference.has(ns)) extraNs.push(ns);
  }

  summary.push(
    `${locale}: ${missing.length} missing` +
      (extraNs.length ? `, extra namespaces: ${extraNs.join(", ")}` : ""),
  );

  if (missing.length > 0) {
    failed = true;
    console.error(`\n[${locale}] missing ${missing.length} keys:`);
    for (const k of missing.slice(0, MAX_REPORT)) console.error(`  - ${k}`);
    if (missing.length > MAX_REPORT) {
      console.error(`  ... and ${missing.length - MAX_REPORT} more`);
    }
  }
}

console.log("\ni18n parity summary:");
for (const line of summary) console.log("  " + line);

if (failed) {
  console.error("\ni18n parity check FAILED. Add the missing keys above.");
  process.exit(1);
}
console.log("\ni18n parity OK.");
