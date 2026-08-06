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
//
// ── HOW SPECIFIERS ARE FOUND, and why it is not a regex ─────────────────────────────────────
// This guard originally lexed imports with regular expressions. Three consecutive review rounds
// each found a fresh defect in the SAME invariant family — "which text in this file is a module
// specifier": an attributed dynamic import, a `;` inside a comment ending the import clause, a
// computed specifier, a method named `import`, a stripper that desynced on a regex literal
// containing a quote, `import(` matched inside a string. Each patch was locally correct and the
// family kept producing defects, which is the signature of an incomplete model rather than a
// missing case. Deciding what is code, what is a comment, what is a string and what is a regex
// literal IS parsing; a regex cannot do it, and every patch was an approximation of a lexer.
//
// So the extraction is now the TypeScript parser (a devDependency this repo already type-checks
// with). The contract it satisfies, stated as properties the self-test enforces:
//
//   1. COMPLETE — every specifier the bundler would resolve is reported, in every syntax form:
//      static, side-effect, `export … from`, `export * from`, `import x = require(…)`, dynamic,
//      attributed, multi-line, braced, and specifiers carrying comments inside the clause.
//   2. SOUND — nothing that is not a module specifier is reported: not text in a string, not a
//      comment, not a regex literal, not a call to a method that happens to be named `import`.
//   3. COMPUTED IS A VIOLATION — a dynamic import whose specifier is not a string literal
//      (`import(`…${v}`)`, `import(a + b)`, `import(spec)`) cannot be an exact pin by
//      construction, so it is reported in its own right rather than skipped.
//   4. FAILS CLOSED — a file that will not parse is a violation, never a silent "clean".
//   5. Reported line numbers are real source lines.
// ═══════════════════════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

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

/**
 * Parse one source file and return every module specifier in it.
 *
 * `{ specifiers: [{spec, line}], computed: [{line, expr}], parseError: string|null }`.
 *
 * The TypeScript parser decides what is code, what is a comment, what is a string and what is a
 * regex literal. That is the whole reason it is here: those four distinctions are exactly what a
 * regex kept getting wrong, and they are free from a real parser. `isStringLiteralLike` is true for
 * a plain string and for a template with NO substitutions, and false for an interpolated template —
 * which is precisely the computed/literal boundary this guard needs.
 */
export function parseModule(source, fileName = "module.ts") {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);

  // FAIL CLOSED. `createSourceFile` never throws — it recovers and returns a partial tree — so a
  // file it could not parse would otherwise be reported as having no imports, i.e. as clean.
  const diagnostics = sf.parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const d = diagnostics[0];
    const where = sf.getLineAndCharacterOfPosition(d.start ?? 0).line + 1;
    const what = ts.flattenDiagnosticMessageText(d.messageText, " ");
    return { specifiers: [], computed: [], parseError: `line ${where}: ${what}` };
  }

  const specifiers = [];
  const computed = [];
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const visit = (node) => {
    // `import … from "x"`, `import "x"`, `export … from "x"`, `export * from "x"`
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) {
        specifiers.push({ spec: node.moduleSpecifier.text, line: lineOf(node.moduleSpecifier) });
      }
    }
    // `import x = require("y")`
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const e = node.moduleReference.expression;
      if (e && ts.isStringLiteralLike(e)) specifiers.push({ spec: e.text, line: lineOf(e) });
      else if (e) computed.push({ line: lineOf(e), expr: `import = require(${e.getText(sf).slice(0, 60)})` });
    }
    // `import("x")`, `import("x", { with: … })`, and every computed form. The parser reports the
    // real `import(` call ONLY — `loader.import(…)` is a PropertyAccessExpression, so the member
    // -call false positive cannot arise at all, with or without whitespace or a comment.
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) specifiers.push({ spec: arg.text, line: lineOf(arg) });
      else computed.push({ line: lineOf(arg ?? node), expr: `import(${arg ? arg.getText(sf).slice(0, 60) : ""})` });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { specifiers, computed, parseError: null };
}

/** Every external specifier in one source file, with line numbers. */
export function specifiersIn(source, fileName = "module.ts") {
  return parseModule(source, fileName).specifiers;
}

/** Dynamic imports whose specifier is computed, and so cannot be pinned at all. */
export function computedImportsIn(source, fileName = "module.ts") {
  return parseModule(source, fileName).computed;
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
    const { specifiers, computed, parseError } = parseModule(fs.readFileSync(file, "utf8"), file);
    if (parseError) {
      violations.push({ file, line: 1, spec: parseError, kind: "unparseable" });
      continue;
    }
    for (const { spec, line } of specifiers) {
      if (!isPinned(spec)) violations.push({ file, line, spec });
    }
    for (const { line, expr } of computed) {
      violations.push({ file, line, spec: expr, kind: "computed" });
    }
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

const KIND_NOTE = {
  computed: "   <- computed specifier: cannot be pinned; use a literal",
  unparseable: "   <- FILE DID NOT PARSE: treated as a violation, never as clean",
};

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
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.spec}${KIND_NOTE[v.kind] ?? ""}`);
  }
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

  // ── COMPLETENESS: a comment inside the import clause must not hide the import ──────────────
  // A regex bounded by `;` lost these entirely, and a regex literal containing a quote could
  // desync a hand-rolled comment stripper so that BOTH passes lost them. The parser has no such
  // failure mode: it knows what a comment is.
  for (const [label, src] of [
    ["line comment", 'import {\n  x, // explanation; still valid\n} from "npm:hidden-a@2";\n'],
    ["block comment", 'import { x /* explanation; still valid */ } from "npm:hidden-b@2";\n'],
    ["after a regex literal containing a quote",
     'const pattern = /"/;\nimport { x /* note; here */ } from "npm:hidden-c@2";\n'],
    ["after a regex literal containing a slash",
     'const pattern = /a\\/b"/;\nimport { x } from "npm:hidden-d@2";\n'],
  ]) {
    const specs = specifiersIn(src).map((s) => s.spec);
    assert(specs.some((s) => s.startsWith("npm:hidden")), `a comment ${label} hid the import (found: ${specs.join(", ") || "nothing"})`);
  }

  // ── SOUNDNESS: a URL's `//` is not a comment, and import-shaped TEXT is not an import ───────
  assert(
    specifiersIn('import x from "https://esm.sh/pkg@1.2.3";')[0].spec === "https://esm.sh/pkg@1.2.3",
    "a URL inside a string literal was mangled",
  );
  for (const [label, src] of [
    ["a string mentioning import()", 'const help = "call import(spec) here";'],
    ["a regex literal shaped like import()", "const re = /import(spec)/;"],
    ["a commented-out import", '// import { x } from "npm:pkg@2";'],
    ["a floating specifier named in prose", "// we used to import npm:pkg@2 here"],
  ]) {
    assert(specifiersIn(src).length === 0, `${label} was extracted as an import`);
    assert(computedImportsIn(src).length === 0, `${label} was reported as a computed import`);
  }

  // A computed specifier cannot be an exact pin by construction, so it is a violation itself.
  for (const [label, src] of [
    ["template literal", "const m = await import(`npm:pkg@${version}`);"],
    ["concatenation", 'const m = await import("npm:pkg@" + version);'],
    ["bare identifier", "const m = await import(spec);"],
  ]) {
    assert(computedImportsIn(src).length === 1, `computed dynamic import (${label}) not reported`);
  }
  // …but a plain literal is NOT computed — with attributes, as a non-interpolated template, or
  // longer than any fixed scan window a regex would have needed.
  const longSpec = `https://esm.sh/@scope/${"a".repeat(220)}@1.2.3`;
  for (const src of [
    'const m = await import("npm:pkg@1.2.3");',
    'const m = await import("npm:pkg@1.2.3", { with: { type: "json" } });',
    "const m = await import(`npm:pkg@1.2.3`);",
    `const m = await import("${longSpec}");`,
  ]) {
    assert(computedImportsIn(src).length === 0, `plain literal dynamic import wrongly flagged as computed: ${src.slice(0, 60)}…`);
  }
  assert(
    specifiersIn(`const m = await import("${longSpec}");`)[0].spec === longSpec,
    "a specifier longer than a scan window was truncated or lost",
  );

  // A method that happens to be named `import` is an ordinary call, not a module load — including
  // the whitespace and comment forms, which a lookbehind on the keyword could not reject.
  for (const [label, src] of [
    ["plain", 'loader.import("npm:pkg@2", options);'],
    ["space before the property", 'loader. import("npm:pkg@2", options);'],
    ["comment before the property", 'loader./* gap */import("npm:pkg@2", options);'],
    ["optional chaining", 'loader?.import("npm:pkg@2", options);'],
    ["computed member", 'loader["import"]("npm:pkg@2", options);'],
  ]) {
    assert(specifiersIn(src).length === 0, `a .import() method call (${label}) was extracted as a dynamic import`);
    assert(computedImportsIn(src).length === 0, `a .import() method call (${label}) was reported as computed`);
  }

  // FAIL CLOSED: a file that will not parse is a violation, never a silent "clean". Without this
  // the parser's error recovery would return an empty import list and the file would pass.
  const broken = parseModule('import { x from "npm:pkg@2"\nfunction (( {');
  assert(broken.parseError !== null, "an unparseable file did not report a parse error");
  assert(broken.specifiers.length === 0, "an unparseable file still yielded specifiers");

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
