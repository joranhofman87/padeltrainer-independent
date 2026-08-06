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
//      static, side-effect, `export … from`, `export * from`, `import x = require(…)`, a bare
//      `require(…)`, dynamic, attributed, multi-line, braced, specifiers carrying comments inside
//      the clause, and the `@jsxImportSource` pragma — which is a dependency edge with no import
//      statement at all, so it must be read from pragma metadata rather than from the node tree.
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
import os from "node:os";
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
 * `{ specifiers: [{spec, line}], computed: [{line, expr}], parseError: {line, message}|null }`.
 *
 * The TypeScript parser decides what is code, what is a comment, what is a string and what is a
 * regex literal. That is the whole reason it is here: those four distinctions are exactly what a
 * regex kept getting wrong, and they are free from a real parser. `isStringLiteralLike` is true for
 * a plain string and for a template with NO substitutions, and false for an interpolated template —
 * which is precisely the computed/literal boundary this guard needs.
 */
export function parseModule(source, fileName = "module.ts") {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));

  // FAIL CLOSED. `createSourceFile` never throws — it recovers and returns a partial tree — so a
  // file it could not parse would otherwise be reported as having no imports, i.e. as clean.
  const diagnostics = sf.parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const d = diagnostics[0];
    return {
      specifiers: [],
      computed: [],
      parseError: {
        line: sf.getLineAndCharacterOfPosition(d.start ?? 0).line + 1,
        message: ts.flattenDiagnosticMessageText(d.messageText, " "),
      },
    };
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
    // `require("x")` — a CommonJS dependency edge. Only a BARE `require` identifier counts;
    // `obj.require(…)` is an ordinary method call, exactly as with `import`. And only when the
    // name is NOT lexically bound: `function useLoader(require) { require("npm:pkg@2") }` calls a
    // parameter, not the CommonJS loader, and reporting it would be a false CI failure.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === "require" && !isLexicallyBound(node, "require")) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) specifiers.push({ spec: arg.text, line: lineOf(arg) });
      else if (arg) computed.push({ line: lineOf(arg), expr: `require(${arg.getText(sf).slice(0, 60)})` });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // `/** @jsxImportSource https://esm.sh/preact@10 */` — the JSX transform resolves
  // `<factory>/jsx-runtime` from this, so the pragma IS a dependency edge even though no import
  // statement exists. It lives in source-file pragma metadata, not in the node tree, so the
  // visitor above can never see it.
  const jsxPragma = sf.pragmas?.get("jsximportsource");
  for (const entry of jsxPragma === undefined ? [] : [].concat(jsxPragma)) {
    const factory = entry?.arguments?.factory;
    if (typeof factory !== "string" || factory === "") continue;
    specifiers.push({
      spec: factory,
      line: sf.getLineAndCharacterOfPosition(entry.range?.pos ?? 0).line + 1,
    });
  }

  return { specifiers, computed, parseError: null };
}

/**
 * True when `name` is declared in a scope enclosing `node` — a parameter, a `var`/`let`/`const`, or
 * a function declaration. Used to tell the CommonJS `require` loader apart from a local binding
 * that merely shares its name.
 *
 * The two error directions are NOT symmetric, and the asymmetry drives the design. Missing a
 * shadowing form costs a false positive: annoying, visible, harmless. Wrongly reporting a binding
 * SUPPRESSES a real dependency, which is an evasion — the thing this guard exists to prevent. So
 * this errs toward "not bound":
 *
 *   * `declare const require: …` / `declare function require(…)` are AMBIENT. They are erased at
 *     emit, so at runtime the call still reaches the module environment's real `require`. Counting
 *     them as bindings would let `declare const require; require("npm:floating@2")` through.
 *   * It inspects only the direct declarations of enclosing scopes, so destructuring, catch
 *     parameters, loop bindings, class declarations and named function expressions are missed —
 *     all in the false-positive direction, deliberately.
 */
function isLexicallyBound(node, name) {
  const isAmbient = (s) => s.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword) === true;

  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n) && n.parameters?.some((p) => ts.isIdentifier(p.name) && p.name.text === name)) {
      return true;
    }
    const statements = ts.isSourceFile(n) || ts.isBlock(n) || ts.isModuleBlock(n) ? n.statements : null;
    if (!statements) continue;
    for (const s of statements) {
      if (isAmbient(s)) continue; // erased at runtime — not a binding the call can reach
      if (ts.isVariableStatement(s)
          && s.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name)) {
        return true;
      }
      if (ts.isFunctionDeclaration(s) && s.name?.text === name) return true;
    }
  }
  return false;
}

/** Parse each extension as what it is, so syntax validation (and so fail-closed) is honest. */
function scriptKindFor(fileName) {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
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
    else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name)) out.push(p);
  }
  return out;
}

export function findFloating(root = FUNCTIONS_ROOT) {
  const violations = [];
  for (const file of walk(root)) {
    const { specifiers, computed, parseError } = parseModule(fs.readFileSync(file, "utf8"), file);
    if (parseError) {
      violations.push({ file, line: parseError.line, spec: parseError.message, kind: "unparseable" });
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

  // A JSX import-source pragma IS a dependency edge — the transform resolves
  // `<factory>/jsx-runtime` from it — but it lives in pragma metadata, not in the node tree, so a
  // visitor alone can never see it.
  const pragmaSrc = "/** @jsxImportSource https://esm.sh/preact@10 */\nexport const v = <div />;\n";
  const pragmaSpecs = specifiersIn(pragmaSrc, "view.tsx").map((s) => s.spec);
  assert(pragmaSpecs.includes("https://esm.sh/preact@10"), `jsxImportSource pragma not scanned (found: ${pragmaSpecs.join(", ") || "nothing"})`);
  assert(!isPinned("https://esm.sh/preact@10"), "the pragma fixture must be a FLOATING specifier to be meaningful");

  // `require("x")` is a CommonJS dependency edge; `obj.require(…)` is an ordinary method call.
  assert(specifiersIn('const x = require("npm:pkg@2");')[0]?.spec === "npm:pkg@2", "require() specifier not extracted");
  assert(specifiersIn('const x = obj.require("npm:pkg@2");').length === 0, "obj.require() was extracted as a module load");
  assert(computedImportsIn("const x = require(spec);").length === 1, "computed require() not reported");

  // FAIL CLOSED: a file that will not parse is a violation, never a silent "clean". Without this
  // the parser's error recovery would return an empty import list and the file would pass.
  const broken = parseModule('const ok = 1;\nimport { x from "npm:pkg@2"\nfunction (( {');
  assert(broken.parseError !== null, "an unparseable file did not report a parse error");
  assert(broken.specifiers.length === 0, "an unparseable file still yielded specifiers");
  assert(typeof broken.parseError.line === "number" && broken.parseError.line > 1,
    `a parse error must report its REAL line, not 1 (got ${JSON.stringify(broken.parseError)})`);

  // …and the same through findFloating, which is what actually reports it. Asserting only on
  // parseModule left the wiring untested: a findFloating that hardcoded line 1 stayed green.
  const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-pins-broken-"));
  try {
    fs.writeFileSync(path.join(brokenDir, "bad.ts"), 'const ok = 1;\nimport { x from "npm:pkg@2"\nfunction (( {');
    const reported = findFloating(brokenDir);
    assert(reported.length === 1, `an unparseable file must be exactly one violation (got ${reported.length})`);
    assert(reported[0].kind === "unparseable", "an unparseable file was not reported as such");
    assert(reported[0].line === broken.parseError.line,
      `findFloating reported line ${reported[0].line}, but the parse error is on line ${broken.parseError.line}`);
  } finally {
    fs.rmSync(brokenDir, { recursive: true, force: true });
  }

  // Deno resolves `.cjs`/`.cts`/`.mts`/`.jsx` too; a walk that skipped them would leave real
  // dependency edges unscanned. Exercised on a real directory rather than by reading the regex.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "edge-pins-walk-"));
  try {
    for (const name of ["a.ts", "b.cjs", "c.cts", "d.mts", "e.jsx", "f.tsx", "g.mjs", "h.txt", "i.md"]) {
      fs.writeFileSync(path.join(tmp, name), "");
    }
    const found = walk(tmp).map((f) => path.basename(f)).sort();
    for (const name of ["a.ts", "b.cjs", "c.cts", "d.mts", "e.jsx", "f.tsx", "g.mjs"]) {
      assert(found.includes(name), `walk skipped ${name} — its imports would never be scanned`);
    }
    for (const name of ["h.txt", "i.md"]) {
      assert(!found.includes(name), `walk picked up ${name}, which is not a module`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ── INTEGRATION: every form driven through findFloating, the path the guard actually runs ──
  // Helper-level assertions proved extraction, classification and walking separately, and that is
  // not the same thing: a findFloating that dropped its specifier loop, dropped its computed loop,
  // or ignored what walk returned would satisfy all of them and still report a dirty tree clean.
  // The real-tree fixture cannot catch that either, because the real tree has no violations. So
  // this builds a directory that DOES.
  const integrationDir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-pins-integration-"));
  try {
    const files = {
      "view.tsx": "/** @jsxImportSource https://esm.sh/preact@10 */\nexport const v = <div />;\n",
      "cjs-dep.cjs": 'const p = require("npm:floating-cjs@2");\n',
      "computed.ts": "export const load = () => import(`npm:computed@${v}`);\n",
      "static.mts": 'import { a } from "https://esm.sh/floating-mts@2";\n',
      // TWO violations in one file, after a PINNED one: a specifier loop that stopped at its first
      // element — or at the first violation — would report this file once and look correct.
      "two-in-one.ts": 'import "https://esm.sh/pinned@1.2.3";\nimport "https://esm.sh/floating-first@2";\nimport "https://esm.sh/floating-second@3";\n',
      // An AMBIENT `require` is erased at emit, so the call still reaches the real loader at
      // runtime. Treating it as a binding would suppress a genuine dependency — an evasion.
      "ambient.cts": 'declare const require: (s: string) => unknown;\nconst d = require("npm:floating-ambient@2");\n',
      "clean.ts": 'import { b } from "https://esm.sh/pinned@1.2.3";\nimport c from "./local.ts";\n',
    };
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(integrationDir, name), body);

    const reported = findFloating(integrationDir);
    const specsFor = (name) => reported.filter((v) => path.basename(v.file) === name);
    const one = (name) => specsFor(name)[0];

    assert(one("view.tsx")?.spec === "https://esm.sh/preact@10", "findFloating did not report the floating jsxImportSource pragma");
    assert(one("cjs-dep.cjs")?.spec === "npm:floating-cjs@2", "findFloating did not report a floating require() in a .cjs file");
    assert(one("computed.ts")?.kind === "computed", "findFloating did not report the computed dynamic import");
    assert(one("static.mts")?.spec === "https://esm.sh/floating-mts@2", "findFloating did not report a floating import in a .mts file");
    assert(one("ambient.cts")?.spec === "npm:floating-ambient@2", "an AMBIENT `declare const require` suppressed a real dependency — this is an evasion, not a false positive");
    assert(specsFor("clean.ts").length === 0, "findFloating reported a violation in the clean file");

    // BOTH violations in the two-violation file, so a loop that stops after its first element fails.
    const two = specsFor("two-in-one.ts").map((v) => v.spec).sort();
    assert(two.length === 2, `expected 2 violations in two-in-one.ts, got ${two.length}`);
    assert(two[0] === "https://esm.sh/floating-first@2" && two[1] === "https://esm.sh/floating-second@3",
      `wrong specifiers from the multi-violation file: ${two.join(", ")}`);

    assert(reported.length === 7, `findFloating reported ${reported.length} violations, expected exactly 7`);
    assert(reported.every((v) => v.line >= 1), "a violation carried no usable line number");
    // The second violation is on a later line than the first — line numbers are per-specifier,
    // not per-file.
    assert(specsFor("two-in-one.ts")[0].line !== specsFor("two-in-one.ts")[1].line,
      "two violations in one file were reported on the same line");

    // A pinned pragma and a shadowed `require` must NOT be violations — the false-positive side.
    fs.rmSync(path.join(integrationDir, "view.tsx"));
    fs.rmSync(path.join(integrationDir, "cjs-dep.cjs"));
    fs.rmSync(path.join(integrationDir, "computed.ts"));
    fs.rmSync(path.join(integrationDir, "static.mts"));
    fs.rmSync(path.join(integrationDir, "two-in-one.ts"));
    fs.rmSync(path.join(integrationDir, "ambient.cts"));
    fs.writeFileSync(path.join(integrationDir, "pinned-view.tsx"), "/** @jsxImportSource https://esm.sh/preact@10.19.3 */\nexport const v = <div />;\n");
    fs.writeFileSync(path.join(integrationDir, "shadowed.ts"), 'export function useLoader(require: (s: string) => unknown) {\n  return require("npm:pkg@2");\n}\n');
    fs.writeFileSync(path.join(integrationDir, "shadowed-const.ts"), 'const require = customLoader;\nrequire("npm:pkg@2");\n');
    const clean = findFloating(integrationDir);
    assert(clean.length === 0, `a pinned pragma or shadowed require was reported: ${clean.map((v) => `${path.basename(v.file)}:${v.line} ${v.spec}`).join("; ")}`);
  } finally {
    fs.rmSync(integrationDir, { recursive: true, force: true });
  }

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
