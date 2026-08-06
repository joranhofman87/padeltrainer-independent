#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════════════════
// Every external module that can enter an edge-function deployment bundle must name an EXACT
// version.
//
// WHY THIS EXISTS. On 2026-08-06 the N0–N7 inert deployment partially failed: 15 of 18 functions
// would not deploy. The cause was not our code. `https://esm.sh/@supabase/supabase-js@2` is a
// floating specifier — esm.sh resolves it to whatever it currently considers latest, and that day
// it resolved to a build depending on `@supabase/postgrest-js@2.112.2`, a version that was not
// published. The bundle could not be built.
//
// The instructive part is what happened either side of that. `mollie-webhook` carries the SAME
// floating specifier and deployed successfully in the same run; two functions that pin exactly
// deployed cleanly. And a day earlier the floating specifier resolved to something that worked.
// So the defect is NOT "upstream is broken" — upstream will be fixed, and was already changing
// under us. The defect is that our deployability depends on a third party's mutable pointer. A
// build that succeeds or fails according to what a CDN decided this hour is not reproducible, and
// the failure lands at deploy time, on a release, with no local reproduction.
//
// The rule is therefore about the SPECIFIER, not about any particular upstream version: a
// deployment bundle may not contain a version range. `@2` is a range. `@2.0` is a range. `^2.57.2`
// is a range. `@2.57.2` is a version.
//
// SCOPE. Entrypoints AND `_shared/` modules — a shared module is bundled into every function that
// imports it, which is exactly how five of the fifteen failures happened: their own entrypoints
// were clean and they inherited the floating specifier transitively. Test files are scanned too;
// a floating import breaks CI the same way it breaks a deploy.
// ═══════════════════════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";

export const FUNCTIONS_ROOT = "supabase/functions";

/** Bare specifiers Deno resolves itself; they carry no third-party version. */
const BUILTIN_PREFIXES = ["node:", "bun:", "deno:", "cloudflare:"];

/**
 * An exact version: 1.2.3, with an OPTIONAL prerelease and an OPTIONAL build-metadata suffix, in
 * that order — SemVer allows both at once (`1.2.3-rc.1+build.7`). Accepting only one of the two
 * cannot let a range through, but it wrongly rejects a legitimately immutable pin. Deno.land writes
 * the same versions with a leading `v`.
 */
const EXACT_VERSION = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Split an external specifier into { registry, name, version, subpath }.
 * Returns { version: null } when the specifier names no version at all.
 * Returns null when the specifier is not a versioned third-party module (builtins, same-origin
 * URLs we control, data: URLs) and so is out of scope.
 */
export function parseSpecifier(spec) {
  if (spec.startsWith(".") || spec.startsWith("/")) return null;
  if (BUILTIN_PREFIXES.some((p) => spec.startsWith(p))) return null;
  if (spec.startsWith("data:")) return null;

  // npm: / jsr: — `npm:@scope/name@version/sub` or `npm:name@version/sub`
  const bare = /^(npm|jsr):(.+)$/.exec(spec);
  if (bare) return { registry: bare[1], ...splitNameVersion(bare[2]) };

  if (!/^https?:\/\//.test(spec)) {
    // A bare module specifier with no registry prefix. Deno cannot resolve these in an edge
    // bundle without an import map; treat as unversioned so it is surfaced rather than ignored.
    return { registry: "bare", ...splitNameVersion(spec) };
  }

  const url = new URL(spec);
  const segments = url.pathname.replace(/^\//, "");

  if (url.host === "deno.land") {
    // `std@0.190.0/http/server.ts` and `x/jose@v5.2.2/index.ts`
    const rest = segments.startsWith("x/") ? segments.slice(2) : segments;
    return { registry: "deno.land", ...splitNameVersion(rest) };
  }

  // esm.sh, unpkg, cdn.skypack.dev, jsdelivr, and anything else CDN-shaped
  return { registry: url.host, ...splitNameVersion(segments) };
}

/** `@scope/name@version/sub` | `name@version/sub` | `name/sub` → parts. */
function splitNameVersion(rest) {
  const scoped = rest.startsWith("@");
  const parts = rest.split("/");
  // The module identifier is the first segment, or the first two when scoped.
  const idSegments = scoped ? parts.slice(0, 2) : parts.slice(0, 1);
  const subpath = parts.slice(idSegments.length).join("/");
  const id = idSegments.join("/");

  // The version marker is the LAST `@` in the identifier, and never the scope's leading `@`.
  const at = id.lastIndexOf("@");
  if (at <= 0) return { name: id, version: null, subpath };
  return { name: id.slice(0, at), version: id.slice(at + 1), subpath };
}

/** True when the specifier pins one immutable build. */
export function isPinned(spec) {
  const parsed = parseSpecifier(spec);
  if (parsed === null) return true; // out of scope
  if (parsed.version === null) return false;
  return EXACT_VERSION.test(parsed.version);
}

const IMPORT_PATTERNS = [
  // static `import … from "x"` / `export … from "x"`.
  // The clause body must admit `{`, `}` and newlines — a braced or multi-line import list is the
  // common case, and excluding `{` here would silently skip almost every real import in the repo.
  // It is bounded by `;` (lazily) so one import cannot swallow the file.
  /(?:^|[\s;}])(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm,
  // side-effect `import "x"`
  /(?:^|[\s;}])import\s+["']([^"']+)["']/gm,
  // dynamic `import("x")` and `import("x", { with: { … } })`. The specifier may be followed by a
  // comma as well as the closing paren — requiring `)` made every attributed dynamic import
  // invisible to the guard, which is exactly the shape a floating specifier could hide in.
  /\bimport\s*\(\s*["']([^"']+)["']\s*[,)]/gm,
];

/** Every external specifier in one source file, with line numbers. */
export function specifiersIn(source) {
  const found = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(source)) !== null) {
      found.push({ spec: m[1], line: source.slice(0, m.index).split("\n").length });
    }
  }
  return found;
}

export function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(p);
  }
  return out;
}

export function findFloating(root = FUNCTIONS_ROOT) {
  const violations = [];
  for (const file of walk(root)) {
    const source = fs.readFileSync(file, "utf8");
    for (const { spec, line } of specifiersIn(source)) {
      if (!isPinned(spec)) violations.push({ file, line, spec });
    }
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function main() {
  if (!fs.existsSync(FUNCTIONS_ROOT)) {
    console.error(`check:edge-import-pins — ${FUNCTIONS_ROOT} not found; run from the repo root.`);
    process.exit(2);
  }
  const violations = findFloating();
  if (violations.length === 0) {
    const scanned = walk(FUNCTIONS_ROOT).length;
    console.log(`check:edge-import-pins — OK, every external import in ${scanned} edge-function files names an exact version.`);
    return;
  }
  console.error("check:edge-import-pins — FLOATING external imports in the edge-function bundle graph.\n");
  console.error("A deployment bundle may not contain a version range. `@2` is a range; `@2.57.2` is a version.");
  console.error("A floating specifier makes deployability depend on what a CDN resolves this hour — it is");
  console.error("what broke 15 of 18 function deploys on 2026-08-06.\n");
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.spec}`);
  console.error(`\n${violations.length} floating import(s). Pin each to the exact version the repository already uses.`);
  process.exit(1);
}

// ── Self-test: prove the classifier discriminates, on fixtures (run with --self-test) ───────────
// This is the mutation evidence for the guard itself. Every FLOATING fixture must be rejected and
// every PINNED fixture accepted; relax `EXACT_VERSION`, drop a registry branch, or mis-handle a
// scope/subpath and a specific assertion below fails by name.
function selfTest() {
  let n = 0;
  const fail = (msg) => {
    console.error(`SELF-TEST FAILED: ${msg}`);
    process.exit(1);
  };
  const assert = (cond, msg) => {
    n += 1;
    if (!cond) fail(msg);
  };

  // Ranges, in every form the ecosystem writes them. Each of these once shipped, or plausibly
  // could: `@2` is what broke the deploy; `@2/cors` is what shipped in send-campaign-emails.
  const FLOATING = [
    "https://esm.sh/@supabase/supabase-js@2",
    "https://esm.sh/@supabase/supabase-js@2.57",
    "https://esm.sh/@supabase/supabase-js",
    "https://esm.sh/stripe@18",
    "https://esm.sh/resend",
    "npm:@supabase/supabase-js@2",
    "npm:@supabase/supabase-js@2/cors",
    "npm:@supabase/supabase-js@^2.57.2",
    "npm:@supabase/supabase-js@~2.57.2",
    "npm:@supabase/supabase-js@latest",
    "npm:@sanity/client@6",
    "jsr:@std/assert@1",
    "https://deno.land/std/http/server.ts",
    "https://deno.land/x/jose/index.ts",
    "https://cdn.skypack.dev/uuid",
    "https://unpkg.com/lodash@4",
  ];
  for (const spec of FLOATING) {
    assert(!isPinned(spec), `expected FLOATING, classifier accepted: ${spec}`);
  }

  // Exact versions, including scoped names, subpaths, prereleases, and deno.land's `v` prefix.
  const PINNED = [
    "https://esm.sh/@supabase/supabase-js@2.57.2",
    "https://esm.sh/@supabase/supabase-js@2.57.2/dist/module/index.js",
    "https://esm.sh/stripe@18.5.0",
    "https://esm.sh/resend@2.0.0",
    "https://esm.sh/pdf-lib@1.17.1",
    "npm:@supabase/supabase-js@2.57.2",
    "npm:@sanity/client@6.15.20",
    "jsr:@std/assert@1.0.0",
    "https://deno.land/std@0.190.0/http/server.ts",
    "https://deno.land/x/jose@v5.2.2/index.ts",
    "https://esm.sh/@supabase/supabase-js@2.57.2-next.1",
    // SemVer permits a prerelease AND build metadata together. Rejecting this cannot admit a range,
    // but it would block a legitimately immutable pin.
    "https://esm.sh/@supabase/supabase-js@1.2.3-rc.1+build.7",
    "https://esm.sh/pkg@1.2.3+build.7",
  ];
  for (const spec of PINNED) {
    assert(isPinned(spec), `expected PINNED, classifier rejected: ${spec}`);
  }

  // Out of scope: these carry no third-party version and must not be reported.
  for (const spec of ["node:crypto", "./cors.ts", "../_shared/cors.ts", "/abs/path.ts"]) {
    assert(isPinned(spec), `expected OUT OF SCOPE (silently ok): ${spec}`);
  }

  // The scope's leading `@` is not a version marker.
  assert(parseSpecifier("npm:@sanity/client@6").name === "@sanity/client", "scoped name mis-parsed");
  assert(parseSpecifier("npm:@sanity/client@6").version === "6", "scoped version mis-parsed");
  assert(parseSpecifier("npm:@supabase/supabase-js@2.57.2/cors").subpath === "cors", "subpath mis-parsed");
  assert(parseSpecifier("https://deno.land/x/jose@v5.2.2/index.ts").name === "jose", "deno.land/x name mis-parsed");
  assert(parseSpecifier("https://deno.land/std@0.190.0/http/server.ts").version === "0.190.0", "deno.land/std version mis-parsed");
  assert(parseSpecifier("node:crypto") === null, "node: builtin should be out of scope");

  // Extraction must see every import FORM a real edge function uses. A braced or multi-line list
  // is the common case — a pattern that skipped those would report a clean repo while every real
  // import went unchecked, which is the failure mode this assertion exists to prevent.
  const sample = `
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  a,
  b,
} from "npm:@supabase/supabase-js@2";
import "https://esm.sh/side-effect@1";
export { x } from "https://esm.sh/reexport@3";
export type { T } from "https://esm.sh/typeonly@4";
const m = await import("npm:@sanity/client@6");
import local from "../_shared/cors.ts";
export * from "https://esm.sh/starexport@5";
const j = await import("npm:attributed@7", { with: { type: "json" } });
import cfg from "https://esm.sh/withattrs@8" with { type: "json" };
`;
  const specs = specifiersIn(sample).map((s) => s.spec);
  for (const expected of [
    "https://esm.sh/@supabase/supabase-js@2",
    "npm:@supabase/supabase-js@2",
    "https://esm.sh/side-effect@1",
    "https://esm.sh/reexport@3",
    "https://esm.sh/typeonly@4",
    "npm:@sanity/client@6",
    "../_shared/cors.ts",
    "https://esm.sh/starexport@5",
    // An attributed dynamic import: the specifier is followed by a comma, not `)`. Requiring the
    // paren made this whole syntax invisible — a floating specifier could sit here unseen.
    "npm:attributed@7",
    "https://esm.sh/withattrs@8",
  ]) {
    assert(specs.includes(expected), `extraction missed ${expected} (found: ${specs.join(", ")})`);
  }
  assert(
    specifiersIn(sample).find((s) => s.spec === "npm:@sanity/client@6").line === 10,
    "dynamic import line number wrong",
  );

  // The real repository is the last fixture: the guard must agree with the tree it guards.
  if (fs.existsSync(FUNCTIONS_ROOT)) {
    const real = findFloating();
    assert(real.length === 0, `repository has ${real.length} floating import(s): ${real.map((v) => `${v.file}:${v.line} ${v.spec}`).join("; ")}`);
    assert(walk(FUNCTIONS_ROOT).length > 100, "scanned suspiciously few edge-function files");
  }

  console.log(`OK — self-test passed (${n} assertions incl. the real repository).`);
}

if (process.argv.includes("--self-test")) selfTest();
else if (import.meta.url === `file://${process.argv[1]}`) main();
