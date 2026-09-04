// ══ THE CATALOGUE SENDS WHAT IT HOLDS, AND CHECKS BEFORE IT SENDS ════════════════════════════
//
// `src/test/abc27ApplyCatalogue.ts` is the only place either writing apply routine is spelled, and
// the static guard proves that: G3 audits every statement through PostgreSQL's own grammar and
// G4 refuses any other decoded token in the `abc27` family that names one. This file proves the
// half that actually holds at run time:
//
//   every entrypoint sends the statement the module holds — byte for byte — and asks the
//   ownership registry about the values it received before anything reaches the server.
//
// WHY THAT IS THE HALF THAT HOLDS. The predecessor of this design proved, by reading the suite's
// syntax tree, that a guard DOMINATED each writing invocation. Four review rounds produced four
// ways past that reader: a hole in an expression position that IS a call, a `for…of` destructuring
// default, a computed subscript into a stored call map, a constructor parameter property. Every
// fix moved the hole, because there is no oracle for JavaScript dataflow.
//
// A registry lookup at execution time is immune to all four, because by the time it runs there is
// no expression left: there are values, and either this test owns them or it does not. Every
// escape above can only change WHICH VALUES ARRIVE, and which values arrive is what is judged.
//
// NO DATABASE. The client is a stub that records what it was asked to send, so this costs
// milliseconds rather than a lineage replay — and a sensor that cheap runs on every change.
//
// DELIBERATELY OUTSIDE THE STATIC GUARD'S PROGRAM, exactly like the slot factory's runtime test.
// It is in the scope-drift set instead, where `checkScopeDrift` refuses any `abc27*` file that
// sends SQL and G4 refuses any that spells a writing routine — which is why NOTHING BELOW NAMES
// EITHER ROUTINE. It asserts DIGESTS, which is what the catalogue publishes in place of texts.
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BOOTSTRAP_IDENTITY, currentIdentity, installTrainerAuthorityHooks, noteSlotsOwned, slotOwner,
} from './abc27TrainerAuthority';
import { WRITING_APPLY_ROUTINES } from '../../scripts/check-abc27-trainer-source-authority.mjs';
import { loadOracle, nodesOf, parseSql } from '../../scripts/abc27ParseOracle.mjs';
import * as CATALOGUE from './abc27ApplyCatalogue';
import {
  APPLY_CANONICAL_EXAMPLES, APPLY_ENTRYPOINTS, APPLY_STATEMENT_DIGESTS,
  applyCommandAsActorReachability, applyCommandAsActorReceiptPrivacy,
  applyCommandAsActorRefusalProbe, applyCommandAsActorRenderedBarrier, applyNormalizedCore,
  applyNormalizedCoreShaped, applyNormalizedCoreShapedExtend, canonicalByteaHexFromBytes,
  type RenderedArray,
} from './abc27ApplyCatalogue';

installTrainerAuthorityHooks();

// THE SUBJECT STAYS FROZEN, AND THE FROZEN MODULE IS PINNED WHOLE — see 'the frozen module is
// one whole authority' below. `CATALOGUE_DIGEST` is the literal SHA-256 of every byte of
// `src/test/abc27ApplyCatalogue.ts`, read before any import of this file has executed; the
// structural controls read the same bytes through a
// TypeScript Program and RESOLVE every name they pin, because a pinned callee TEXT is a pin on a
// spelling and a spelling can be shadowed — a local `canonicalByteaHex`, a default parameter
// named `LOWER_HEX` — while the pinned text stays exactly what it was. `noLib` and `noResolve`:
// the question is lexical provenance inside the frozen subject, and a global the Program has no
// declaration for reads as exactly that — which is what an unshadowed `Error` or `Object` should
// read as.
const CATALOGUE_RELATIVE = 'src/test/abc27ApplyCatalogue.ts';
const CATALOGUE_PATH = resolve(process.cwd(), CATALOGUE_RELATIVE);
/**
 * THE COMPLETE RAW BYTES OF THE FROZEN MODULE, READ BEFORE ANY IMPORT EXECUTES. `vi.hoisted` runs
 * ahead of every static import of this file, so the catalogue — and every other frozen module
 * this file imports — has not yet run when its bytes are taken: what is hashed is the module as
 * it was on disk before any imported code could touch the disk. (The path is spelled inline
 * because a hoisted block cannot see this module's own bindings.)
 */
const CATALOGUE_BYTES = await vi.hoisted(async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  return readFileSync(resolve(process.cwd(), 'src/test/abc27ApplyCatalogue.ts'));
});
/**
 * THE REVIEWED DIGEST, AS A LITERAL. Nothing here computes, normalises or updates it from the
 * bytes it judges: a legitimate change to the frozen module is an explicit repin of this value
 * plus a fresh deep review, and version control plus this pin are the change authority.
 */
const CATALOGUE_DIGEST = 'e4726f1ad6106248073b7b640876bed741371929e0f1f314317d06824ac7d8e1';
const CATALOGUE_PROGRAM = ts.createProgram({
  rootNames: [CATALOGUE_PATH],
  options: {
    module: ts.ModuleKind.ESNext, noLib: true, noResolve: true, target: ts.ScriptTarget.Latest,
  },
});
const CATALOGUE_TREE = ((): ts.SourceFile => {
  const tree = CATALOGUE_PROGRAM.getSourceFile(CATALOGUE_PATH);
  if (tree === undefined) throw new Error(`${CATALOGUE_RELATIVE}: the Program did not load it`);
  const diagnostics = CATALOGUE_PROGRAM.getSyntacticDiagnostics(tree);
  if (diagnostics.length > 0) {
    throw new Error(`${CATALOGUE_RELATIVE}: ${diagnostics.length} syntax diagnostic(s) — a tree `
      + 'that did not parse cannot be pinned');
  }
  return tree;
})();
/**
 * THE TREE IS THE BYTES. The Program reads the file itself, AFTER the imports have executed; if
 * its text were not exactly the decoded pre-import bytes the digest hashes, the structural pins
 * would be readings of a different byte sequence. Asserted by the byte-pin control below.
 */
const CATALOGUE_TREE_IS_THE_BYTES = CATALOGUE_TREE.text === CATALOGUE_BYTES.toString('utf8');
const CATALOGUE_CHECKER = CATALOGUE_PROGRAM.getTypeChecker();

const catalogueVariable = (name: string): ts.VariableDeclaration => {
  const matches: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(CATALOGUE_TREE);
  if (matches.length !== 1) {
    throw new Error(`${CATALOGUE_RELATIVE}: expected one variable named ${name}, got ${matches.length}`);
  }
  return matches[0];
};

const catalogueFunction = (name: string): ts.FunctionDeclaration => {
  const matches: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(CATALOGUE_TREE);
  if (matches.length !== 1) {
    throw new Error(`${CATALOGUE_RELATIVE}: expected one function named ${name}, got ${matches.length}`);
  }
  return matches[0];
};

const nodesMatching = <T extends ts.Node>(
  root: ts.Node, predicate: (node: ts.Node) => node is T,
): T[] => {
  const matches: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matches;
};

/** The declaration named `name`, which must be a module-level `const` of the subject. */
const moduleConst = (name: string): ts.VariableDeclaration => {
  const declaration = catalogueVariable(name);
  const list = declaration.parent;
  const isModuleConst = ts.isVariableDeclarationList(list)
    && (list.flags & ts.NodeFlags.Const) !== 0
    && ts.isVariableStatement(list.parent) && ts.isSourceFile(list.parent.parent);
  if (!isModuleConst) {
    throw new Error(`${CATALOGUE_RELATIVE}: ${name} must be a module-level const, and is not`);
  }
  return declaration;
};

/** The arrow function a module-level const is initialised with, and nothing else. */
const moduleConstArrow = (name: string): ts.ArrowFunction => {
  const { initializer } = moduleConst(name);
  if (initializer === undefined || !ts.isArrowFunction(initializer)) {
    throw new Error(`${CATALOGUE_RELATIVE}: ${name} must be initialised by an arrow function`);
  }
  return initializer;
};

/** A function's signature as a value: no default, rest or optional parameter can hide in it. */
const signatureShape = (fn: ts.ArrowFunction) => ({
  async: fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false,
  typeParameters: fn.typeParameters?.length ?? 0,
  parameters: fn.parameters.map((parameter) => ({
    name: parameter.name.getText(CATALOGUE_TREE),
    type: parameter.type?.getText(CATALOGUE_TREE) ?? null,
    initializer: parameter.initializer?.getText(CATALOGUE_TREE) ?? null,
    rest: parameter.dotDotDotToken !== undefined,
    optional: parameter.questionToken !== undefined,
  })),
  returnType: fn.type?.getText(CATALOGUE_TREE) ?? null,
});

/**
 * The canonical name of a syntax kind. A `Map` built once, NOT `ts.SyntaxKind[kind]`: a computed
 * member is the one shape the sibling-scope rule cannot show is not `.query`, and it refused
 * this file for exactly that spelling. First name wins, so an alias marker such as
 * `FirstTemplateToken` never stands in for `NoSubstitutionTemplateLiteral`.
 */
const KIND_NAMES = new Map<number, string>();
for (const [name, kind] of Object.entries(ts.SyntaxKind)) {
  if (typeof kind === 'number' && !KIND_NAMES.has(kind)) KIND_NAMES.set(kind, name);
}
const kindNameOf = (node: ts.Node): string => KIND_NAMES.get(node.kind) ?? String(node.kind);

/** A function-like declared under a name: a named function, or an arrow or function expression
 *  that initialises a variable. Anything else is anonymous and is named by its container. */
const namedCallableName = (node: ts.Node): string | undefined => {
  if (ts.isFunctionDeclaration(node)) return node.name?.text;
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  return undefined;
};

/** The value-level callables — the scopes a parameter or local can belong to. */
const isValueCallable = (node: ts.Node): node is ts.SignatureDeclaration =>
  ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)
  || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)
  || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node);

/**
 * What an anonymous callable is counted IN: the nearest enclosing named callable, or at module
 * level the top-level declaration whose initializer holds it.
 */
const anonymousContainer = (node: ts.Node): { name: string; root: ts.Node } => {
  for (let scope: ts.Node | undefined = node.parent; scope !== undefined
    && !ts.isSourceFile(scope); scope = scope.parent) {
    const named = namedCallableName(scope);
    if (named !== undefined) return { name: named, root: scope };
    if (ts.isVariableDeclaration(scope) && ts.isIdentifier(scope.name)
      && ts.isVariableDeclarationList(scope.parent) && ts.isVariableStatement(scope.parent.parent)
      && ts.isSourceFile(scope.parent.parent.parent)) {
      return { name: scope.name.text, root: scope };
    }
  }
  return { name: '<module>', root: CATALOGUE_TREE };
};

/**
 * The callable a parameter or local belongs to, by the name it is declared under — or, for an
 * anonymous arrow, by its container and its ordinal among the container's anonymous callables in
 * source order, so two `(v) => …` inside one renderer are two different scopes.
 */
const catalogueCallableName = (node: ts.Node): string => {
  let scope: ts.Node | undefined = node.parent;
  while (scope !== undefined && !isValueCallable(scope)) scope = scope.parent;
  if (scope === undefined) return '<module>';
  const named = namedCallableName(scope);
  if (named !== undefined) return named;
  const container = anonymousContainer(scope);
  const anonymous = nodesMatching(container.root,
    (n): n is ts.SignatureDeclaration => isValueCallable(n) && namedCallableName(n) === undefined);
  return `${container.name}/anonymous#${anonymous.findIndex((n) => n === scope) + 1}`;
};

/** The declaration a destructured binding ultimately belongs to: its parameter or variable. */
const bindingRootOf = (declaration: ts.Node): ts.Node => {
  let node = declaration;
  while (ts.isBindingElement(node) || ts.isArrayBindingPattern(node)
    || ts.isObjectBindingPattern(node)) node = node.parent;
  return node;
};

/**
 * WHAT AN IDENTIFIER RESOLVES TO, as a label a control can pin. `module-const` is a `const`
 * declared at the top of the subject and `module-ambient-const` a `declare const`;
 * `import:<specifier>` a named import and `import-default:<specifier>` a default one;
 * `parameter:<fn>`, `local:<fn>` and `type-parameter:<fn>` the function-scoped shapes;
 * `module-type` and `module-interface` the top-level type declarations; and
 * `<undeclared global>` a name the `noLib` Program has no declaration for — `Error`, `Object`,
 * `Array` — which is precisely what an unshadowed global must read as, because a shadow resolves.
 */
const catalogueAuthority = (identifier: ts.Identifier): string => {
  const symbol = ts.isShorthandPropertyAssignment(identifier.parent)
    ? CATALOGUE_CHECKER.getShorthandAssignmentValueSymbol(identifier.parent)
    : CATALOGUE_CHECKER.getSymbolAtLocation(identifier);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (declaration === undefined) return `${identifier.text}:<undeclared global>`;
  if (declaration.getSourceFile() !== CATALOGUE_TREE) return `${identifier.text}:<foreign>`;
  if (ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration)) {
    const root = bindingRootOf(declaration);
    if (ts.isParameter(root)) return `${identifier.text}:parameter:${catalogueCallableName(root)}`;
    const list = root.parent;
    if (ts.isVariableDeclarationList(list) && ts.isVariableStatement(list.parent)
      && ts.isSourceFile(list.parent.parent)) {
      const ambient = (ts.getModifiers(list.parent) ?? [])
        .some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword);
      const scope = (list.flags & ts.NodeFlags.Const) !== 0 ? 'const'
        : (list.flags & ts.NodeFlags.Let) !== 0 ? 'let' : 'var';
      return `${identifier.text}:module-${ambient ? 'ambient-' : ''}${scope}`;
    }
    return `${identifier.text}:local:${catalogueCallableName(root)}`;
  }
  if (ts.isParameter(declaration)) {
    return `${identifier.text}:parameter:${catalogueCallableName(declaration)}`;
  }
  if (ts.isTypeParameterDeclaration(declaration)) {
    return `${identifier.text}:type-parameter:${catalogueCallableName(declaration)}`;
  }
  if (ts.isImportSpecifier(declaration)) {
    const { moduleSpecifier } = declaration.parent.parent.parent;
    const from = ts.isStringLiteral(moduleSpecifier)
      ? moduleSpecifier.text : '<non-literal specifier>';
    return `${identifier.text}:import:${from}`;
  }
  if (ts.isImportClause(declaration)) {
    const { moduleSpecifier } = declaration.parent;
    const from = ts.isStringLiteral(moduleSpecifier)
      ? moduleSpecifier.text : '<non-literal specifier>';
    return `${identifier.text}:import-default:${from}`;
  }
  if (ts.isTypeAliasDeclaration(declaration) && ts.isSourceFile(declaration.parent)) {
    return `${identifier.text}:module-type`;
  }
  if (ts.isInterfaceDeclaration(declaration) && ts.isSourceFile(declaration.parent)) {
    return `${identifier.text}:module-interface`;
  }
  if (ts.isFunctionDeclaration(declaration) && ts.isSourceFile(declaration.parent)) {
    return `${identifier.text}:module-function`;
  }
  return `${identifier.text}:<${kindNameOf(declaration)}>`;
};

/** A declaring occurrence of a name — the name a node introduces — as opposed to a read of one. */
const isDeclaredName = (identifier: ts.Identifier): boolean => {
  const { parent } = identifier;
  if (ts.isImportSpecifier(parent) && parent.propertyName === identifier) return true;
  if (ts.isBindingElement(parent) && parent.propertyName === identifier) return true;
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return true;
  const declares = ts.isVariableDeclaration(parent) || ts.isParameter(parent)
    || ts.isFunctionDeclaration(parent) || ts.isBindingElement(parent)
    || ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)
    || ts.isMethodSignature(parent) || ts.isTypeAliasDeclaration(parent)
    || ts.isInterfaceDeclaration(parent) || ts.isTypeParameterDeclaration(parent)
    || ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)
    || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)
    || ts.isEnumMember(parent) || ts.isEnumDeclaration(parent) || ts.isClassDeclaration(parent)
    || ts.isModuleDeclaration(parent);
  return declares && ts.getNameOfDeclaration(parent) === identifier;
};

/** A member name, reached through a value or a type: `x.name`, `pg.Client`. */
const isMemberName = (identifier: ts.Identifier): boolean => {
  const { parent } = identifier;
  return (ts.isPropertyAccessExpression(parent) && parent.name === identifier)
    || (ts.isQualifiedName(parent) && parent.right === identifier);
};

/**
 * Every name a node DEPENDS ON — each identifier it reads, not the ones it declares and not the
 * member names it reaches through — resolved and listed once, sorted: the complete set of
 * declarations a body's behaviour can come from, in one value a control pins exactly.
 */
const catalogueDependencies = (root: ts.Node): string[] => {
  const labels = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isDeclaredName(node) && !isMemberName(node)) {
      labels.add(catalogueAuthority(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return [...labels].sort();
};

/**
 * A client stub that records the statements the catalogue sends, in order.
 *
 * ══ AND ANSWERS THE STORED-ROW READ-BACK, RECOGNISED BY SHAPE, NEVER BY NAMING ANY SQL ═════════
 *
 * Every slot-creating entrypoint now reads back what it stored via `verifyStoredSlots`, and that
 * read sends exactly ONE bound parameter, itself an array of the requested ids —
 * `STORED_SLOT_ROWS`'s own `WHERE id = ANY($1::uuid[])`. No other statement in this catalogue
 * sends that shape: every writing call binds either zero parameters (the two fully-rendered
 * entrypoints) or many positional ones (five, seven or thirty-four). So the read-back is told
 * apart by `values.length === 1 && Array.isArray(values[0])` — a property of what was SENT, not
 * a name this file is forbidden from spelling — and answered with one row per requested id, each
 * given a FRESH, UNOWNED trainer. That is sufficient: the entrypoints call `verifyStoredSlots`
 * with no expected-trainer set, so an unowned trainer clears the authority's not-foreign check
 * without asserting anything about identity, exactly as a real, uncontended row would.
 */
const recordingClient = () => {
  const sent: Array<{ text: string; values: unknown[] }> = [];
  return {
    sent,
    client: {
      query: async (text: string, values: unknown[] = []) => {
        sent.push({ text, values });
        if (values.length === 1 && Array.isArray(values[0])) {
          return {
            rows: (values[0] as unknown[])
              .filter((id): id is string => typeof id === 'string')
              .map((id) => ({ id, trainer_id: randomUUID() })),
          };
        }
        return { rows: [{}] };
      },
    } as never,
  };
};

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** The fixture fingerprint in the boundary's own currency: the bytes of `abc27` as canonical hex.
 *  The catalogue takes a primitive here, so this file mints no `Buffer` to hand it one. */
const FP_HEX = '6162633237';

/**
 * DROPS THE STORED-ROW READ-BACK from a captured `sent` list, by the SAME shape the stub itself
 * recognises it by — never by naming any SQL. Six of the seven entrypoints now read back what
 * they stored before returning, so "the apply sent exactly one statement" is true of the APPLY
 * alone; this is what lets every existing byte-equality and ownership control keep asking that
 * question without also asking "and did it verify", which the dedicated tests below ask instead.
 */
const withoutReadBack = (list: ReadonlyArray<{ text: string; values: unknown[] }>) =>
  list.filter((q) => !(q.values.length === 1 && Array.isArray(q.values[0])));

/** A slot id written by one test and aimed at by the next — the cross-test reuse this refuses. */
let foreignSlot = '';

/** The ordinary presentation of an identity list, matching the catalogue's own union. */
const list = (values: readonly string[],
  type: 'uuid' | 'date' | 'text' = 'uuid'): RenderedArray => ({ kind: 'literal', type, values });

/**
 * Every entrypoint, driven with its own arguments — parameterised so each test can supply its OWN
 * slot and target ids.
 *
 * WHY NOT REUSE THE CANONICAL EXAMPLES EVERYWHERE. The registry claims a target the moment an
 * entrypoint sends, so a second test driving the same canonical ids would be refused for owning
 * nothing — correctly, and for a reason that has nothing to do with the case under test. The
 * digest control below is the ONE place the canonical examples are driven, because the digests
 * are taken over exactly those arguments; every other control mints its own.
 */
const drives = (o: {
  slots: readonly string[]; targets: readonly string[];
  // ── THE PLAIN AND THE RENDERED LIST ARE SEPARATE INPUTS, AND THE MATRICES SEPARATE THEM ────
  //
  // A review round pointed out that driving both from ONE array makes the guard's two halves
  // indistinguishable: removing `uuidsOf(s.sources)` from an entrypoint still refused, because
  // `s.slots` carried the same foreign id. These default to the plain lists — the ordinary case —
  // and the matrices below override them to put the foreign id in exactly one of the two.
  renderedSources?: readonly string[]; renderedTargets?: readonly string[];
  // THE FINGERPRINT IS AN INPUT TOO, so the refusal matrices can drive a bad one through EVERY
  // fingerprint-bearing entrypoint rather than through one. `undefined` is itself a driven shape,
  // which is why presence and not value decides whether the default applies.
  fingerprintHex?: unknown;
}) => {
  const round = randomUUID();
  const command = randomUUID();
  const academy = randomUUID();
  const actor = randomUUID();
  const fingerprintHex = 'fingerprintHex' in o ? o.fingerprintHex : FP_HEX;
  const rendered = {
    slots: o.slots, targets: o.targets,
    sources: list(o.renderedSources ?? o.slots), children: list([randomUUID()]),
    targetArray: list(o.renderedTargets ?? o.targets),
  };
  return {
    applyNormalizedCore: (client: never) => applyNormalizedCore(client, {
      actor, academy, version: 'abc27.wire.v1', kind: 'create', command, round, expected: null,
      label: 'Runtime', start: '2026-10-05', end: null, weeks: 2, prio: 7, member: 0,
      pay: 'deferred_split', strict: false, mode: 'inherit', split: false, review: false,
      price: null, auto: true, lead: null, isub: null, ibody: null, rsub: null, rbody: null,
      rules: null, claim: null, hFrom: [], hTo: [], hLabel: [],
      slots: o.slots, children: [randomUUID()], targets: o.targets, fingerprintHex,
    }),
    applyCommandAsActorReceiptPrivacy: (client: never) =>
      applyCommandAsActorReceiptPrivacy(client, {
        academy, command, round, slots: o.slots, children: [randomUUID()], targets: o.targets,
        fingerprintHex,
      }),
    applyCommandAsActorRefusalProbe: (client: never) =>
      applyCommandAsActorRefusalProbe(client, { academy }),
    applyNormalizedCoreShaped: (client: never) => applyNormalizedCoreShaped(client, {
      actor, academy, command, round, fingerprintHex,
      holidayFrom: list(['2026-12-21'], 'date'), holidayTo: list(['2026-12-22'], 'date'),
      holidayLabel: list(['Kerst'], 'text'), ...rendered,
    }),
    applyNormalizedCoreShapedExtend: (client: never) =>
      applyNormalizedCoreShapedExtend(client, { actor, academy, command, round, fingerprintHex,
        ...rendered }),
    applyCommandAsActorRenderedBarrier: (client: never) =>
      applyCommandAsActorRenderedBarrier(client, { academy, round, fingerprintHex, ...rendered }),
    applyCommandAsActorReachability: (client: never) => applyCommandAsActorReachability(client, {
      academy, command, round, slots: o.slots, children: [randomUUID()], targets: o.targets,
      fingerprintHex,
    }),
  } as Record<string, (client: never) => Promise<unknown>>;
};

describe('ABC-27 apply catalogue — what it sends is what it holds', () => {
  it('publishes a digest per entrypoint, and a digest is not a text', () => {
    // ══ THE POINT OF PUBLISHING DIGESTS AT ALL ═══════════════════════════════════════════════
    //
    // The slot factory exports `SLOT_STATEMENTS` so a control can compare what it sent against
    // what it holds. This module deliberately does not: a text outside the module is a text that
    // can be re-sent and re-spelled, which is exactly the containment G4 enforces. A sha256 hex
    // digest proves the same property and cannot be invoked — so an inventory entry that stopped
    // being a digest would be the mutation, and this is the assertion that sees it.
    for (const [name, digest] of Object.entries(APPLY_STATEMENT_DIGESTS)) {
      expect(digest, `${name} must publish a sha256 hex digest, not a statement`)
        .toMatch(/^[0-9a-f]{64}$/);
    }
    expect(Object.keys(APPLY_STATEMENT_DIGESTS).slice().sort())
      .toEqual([...APPLY_ENTRYPOINTS].sort());
    // ...AND THE SEVEN DIGESTS ARE SEVEN DIFFERENT STATEMENTS. Two entrypoints publishing one
    // digest would mean one of them sends the other's statement, which the drive below could not
    // tell apart on its own.
    expect(new Set(Object.values(APPLY_STATEMENT_DIGESTS)).size,
      'each entrypoint holds its own statement').toBe(APPLY_ENTRYPOINTS.length);
  });

  it('has exactly these exports — a new one cannot arrive unaudited', () => {
    // ══ "EVERY ENTRYPOINT" IS A CLAIM ABOUT THE MODULE, NOT ABOUT THIS TEST ══════════════════
    //
    // The static guard pins this surface too (G3-e), and it is restated here for the same reason
    // the factory restates its own: a new export is a place where a reader is asked whether it
    // needs the ownership check, and two pins in two runners is what makes that unavoidable.
    // THE WHOLE SURFACE, not just the function-valued half — a raw text hidden in an exported
    // object is precisely the escape the digest inventory exists to close.
    expect(Object.keys(CATALOGUE).sort()).toEqual([
      'APPLY_CANONICAL_EXAMPLES', 'APPLY_ENTRYPOINTS', 'APPLY_STATEMENT_DIGESTS',
      'applyCommandAsActorReachability', 'applyCommandAsActorReceiptPrivacy',
      'applyCommandAsActorRefusalProbe', 'applyCommandAsActorRenderedBarrier',
      'applyNormalizedCore', 'applyNormalizedCoreShaped', 'applyNormalizedCoreShapedExtend',
      'canonicalByteaHexFromBytes',
    ]);
    // THE ADAPTER IS A FUNCTION BUT NOT AN ENTRYPOINT: it sends nothing and converts what the
    // DRIVER returned into the boundary's canonical hex, so it is named here rather than being
    // allowed to blur the entrypoint inventory.
    expect(Object.entries(CATALOGUE).filter(([, v]) => typeof v === 'function')
      .map(([k]) => k).sort())
      .toEqual([...APPLY_ENTRYPOINTS, 'canonicalByteaHexFromBytes'].sort());
    // ...AND NOTHING EXPORTED IS A STATEMENT. Every exported value is a function, a digest map or
    // an argument record; a string that carries SQL among them would be a raw text export.
    //
    // ── THIS WALK USED TO STOP, AND IT USED TO LOOK FOR ONE WORD ─────────────────────────────
    //
    // Two holes, both found by a review round. The depth cut-off at four returned `[]` for
    // anything nested below it, so an ordinary `SELECT` buried six levels down was not examined
    // at all — the cut-off silently CERTIFIED what it declined to read. And the test was a search
    // for `select`, so a text that reaches the routine another way — the bare routine name, or
    // `VALUES(public.<routine>(...))` — was not statement-shaped by that definition and passed.
    //
    // The walk is now total (cycles guarded rather than depth), and it looks for what actually
    // matters: any spelling of either writing routine, and the SQL verbs that carry one.
    // KEYS ARE TEXT TOO, and so are map entries and symbol-named properties. `Object.values`
    // alone read none of them, so `{ 'SELECT …': true }` exported a recoverable statement as a
    // KEY while every other pin stayed satisfied. "Total" has to mean total.
    // WHAT IT CANNOT READ, IT REPORTS — it does not skip it. Three kinds of property were
    // silently dropped: a FUNCTION export (skipped wholesale, though a function carries own
    // properties and `Object.defineProperty(fn, 'sql', …)` hides a statement on one), an
    // ACCESSOR (a descriptor has no `value`, so `?.value` read `undefined` and moved on), and
    // own properties of a `Map`/`Set` (the container branch returned before reading them). A
    // walk that quietly certifies what it declined to look at is worse than one that stops.
    //
    // Values come through a DESCRIPTOR, never `obj[k]`: a computed member is the shape the
    // sibling-scope rule cannot clear, and it refused this file for one — correctly. It also
    // means a getter is never INVOKED, only noticed.
    // The language's own prototypes. Anything reachable only through these is machinery, not
    // something this module exports.
    const INTRINSIC_PROTOTYPES: ReadonlySet<unknown> = new Set<unknown>([
      Object.prototype, Array.prototype, Function.prototype, Map.prototype, Set.prototype,
      RegExp.prototype, Date.prototype, Error.prototype, Promise.prototype, Buffer.prototype,
      Uint8Array.prototype, Object.getPrototypeOf(Uint8Array.prototype),
      Object.getPrototypeOf(async () => undefined),
      Object.getPrototypeOf(function* gen() { yield 0; }),
    ]);
    const walkExport = (root: unknown) => {
      const texts: string[] = [];
      const opaque: string[] = [];
      const seen = new Set<unknown>();
      const visit = (v: unknown, path: string): void => {
        if (typeof v === 'string') { texts.push(v); return; }
        if (typeof v === 'symbol') { texts.push(v.description ?? ''); return; }
        if (v === null || v === undefined) return;
        const kind = typeof v;
        if (kind === 'number' || kind === 'boolean' || kind === 'bigint') return;
        if (kind !== 'object' && kind !== 'function') { opaque.push(`${path}: ${kind}`); return; }
        if (seen.has(v)) return;
        seen.add(v);
        if (v instanceof Map) {
          let i = 0;
          for (const [k, inner] of v) {
            visit(k, `${path}.<map key ${i}>`); visit(inner, `${path}.<map value ${i}>`); i += 1;
          }
        }
        if (v instanceof Set) {
          let i = 0;
          for (const inner of v) { visit(inner, `${path}.<set member ${i}>`); i += 1; }
        }
        // ...AND THE PROTOTYPE CHAIN, BOUNDED AT THE INTRINSICS. `Object.create({ sql: 'SELECT
        // …' })` carries recoverable text on an object whose OWN keys are empty, so own-key
        // traversal read nothing at all. The chain stops at the language's own prototypes: those
        // are not exported data, and walking into them reaches `Function.prototype.caller`, which
        // is an accessor this would then have to report forever.
        const proto = Object.getPrototypeOf(v as object);
        if (proto !== null && !INTRINSIC_PROTOTYPES.has(proto)) {
          visit(proto, `${path}.<prototype>`);
        }
        for (const k of Reflect.ownKeys(v as object)) {
          const key = typeof k === 'symbol' ? (k.description ?? '<symbol>') : String(k);
          // ── `constructor` IS NOT SPECIAL-CASED, AND IT USED TO BE ──────────────────────────
          //
          // `Reflect.ownKeys` returns OWN properties only — it never surfaces the INHERITED
          // `constructor` every plain object gets from its prototype, because an inherited
          // property is not an own key. So a `constructor` seen HERE, at this loop, is always a
          // genuine own data property: `{ constructor: { sql: 'SELECT 1' } }` creates one, and it
          // shadows nothing dangerous. The old rule treated every such key as a back-reference to
          // a built-in and skipped its VALUE unread — which is exactly how `{ constructor: {
          // sql: 'SELECT 1' } }` would have carried a statement past this walk.
          //
          // The chain walk above is what actually reaches an INHERITED `constructor` — through a
          // class instance's non-intrinsic prototype, say — and it is bounded at
          // `INTRINSIC_PROTOTYPES` for exactly the concern this special case was trying to name.
          // Reading an own `constructor` value here cannot bypass that bound: the cycle guard
          // (`seen`) stops a class's own back-reference to itself from looping, and an accessor
          // property (`Function.prototype.caller`'s shape) is reported as opaque below rather
          // than invoked, whichever key it is found under.
          texts.push(key);
          const d = Object.getOwnPropertyDescriptor(v as object, k);
          if (d === undefined) { opaque.push(`${path}.${key}: no descriptor`); continue; }
          if ('value' in d) visit(d.value, `${path}.${key}`);
          else opaque.push(`${path}.${key}: accessor`);
        }
      };
      visit(root, 'export');
      return { texts, opaque };
    };
    // THE ROUTINE NAMES ARE TAKEN FROM THE GUARD, NOT SPELLED HERE. Writing them out would be a
    // mention outside the catalogue, which is exactly what G4 refuses — and it did refuse this
    // when they were spelled. Deriving them keeps the check total without adding an occurrence.
    // EACH PATTERN IS A STATEMENT SHAPE, NOT A WORD. Bare words over-reject as soon as the
    // walk reads KEYS: `values` is an ordinary field name in a rendered-array record, and `Call
    // Back` is an ordinary label. Each verb is required with the syntax that makes it a
    // statement, and each routine name with identifier boundaries so a longer name that merely
    // starts the same way — `…_core_v2` — is a different routine, exactly as G4 reads it.
    // THE SAME BOUNDARY CLASS G4 USES. An ASCII approximation reintroduces exactly the
    // false-positive class G4 was fixed for: `…_core·suffix` is an ordinary LONGER identifier,
    // because U+00B7 is `ID_Continue`.
    const PART = '[\\p{ID_Continue}$\\u200c\\u200d]';
    const BOUNDED = (r: string) => `(?<!${PART})${r}(?!${PART})`;
    const FORBIDDEN = [
      /\bselect\s/i, /\bvalues\s*\(/i, /\binsert\s+into\b/i, /\bupdate\b[\s\S]*\bset\b/i,
      /\bdelete\s+from\b/i, /\bmerge\s+into\b/i, /\bcall\s+[\w.]+\s*\(/i, /\bdo\b\s*\$/i,
      ...WRITING_APPLY_ROUTINES.map((r: string) => new RegExp(BOUNDED(r), 'iu')),
    ];
    const offending = (value: unknown): string | undefined =>
      walkExport(value).texts.find((text) => FORBIDDEN.some((r) => r.test(text)));
    // EVERY export, functions included — one used to be skipped for being callable.
    const seenNames: string[] = [];
    for (const [name, value] of Object.entries(CATALOGUE)) {
      const { texts, opaque } = walkExport(value);
      expect(texts.find((t) => FORBIDDEN.some((r) => r.test(t))),
        `${name} carries a statement-shaped string`).toBe(undefined);
      expect(opaque, `${name} carries a property this walk cannot read, so it cannot clear it`)
        .toEqual([]);
      seenNames.push(name);
    }
    // ...AND THE LOOP DEMONSTRABLY RAN OVER THE REAL SURFACE. The previous tripwire only proved
    // a non-function export EXISTED, which stays true when the loop is deleted. This names what
    // the walk actually returned from the module.
    expect(seenNames.sort(), 'the walk must have visited every export by name')
      .toEqual(Object.keys(CATALOGUE).sort());
    expect(walkExport(CATALOGUE).texts, 'and the module itself must be walkable end to end')
      .toContain('APPLY_STATEMENT_DIGESTS');
    // ...AND EVERY PART OF THE SCAN IS DRIVEN, because on a CLEAN surface none of it can be
    // shown to work: a depth cut-off, a missing verb and an unread key all agree with an export
    // that carries nothing. Each pattern and each container gets its own case, so removing any
    // one of them turns a case red rather than passing unnoticed.
    expect(offending({ a: { b: { c: { d: { e: { f: 'SELECT 1' } } } } } }),
      'a statement nested below the old cut-off must be found, not silently certified')
      .toBe('SELECT 1');
    // EACH VERB DRIVEN BY A TEXT ONLY IT MATCHES. `INSERT INTO t VALUES(1)` also matched the
    // VALUES pattern, so deleting the INSERT pattern changed nothing — the comment claimed every
    // pattern had its own case and it did not. `DEFAULT VALUES` has no paren, so it reaches the
    // INSERT pattern alone.
    for (const verb of ['SELECT 1', 'VALUES(1)', 'INSERT INTO t DEFAULT VALUES', 'UPDATE t SET a=1',
      'DELETE FROM t', 'MERGE INTO t USING s ON true', 'CALL p()', 'DO $$ BEGIN END $$']) {
      expect(offending({ v: verb }), `${verb} must be found`).toBe(verb);
    }
    // ...AND THE ORDINARY DATA EACH VERB WOULD OTHERWISE SWALLOW, so the patterns are shapes.
    for (const ordinary of ['values', 'Call Back', 'an update', 'select', 'do it',
      `${WRITING_APPLY_ROUTINES[0]}_v2`, `${WRITING_APPLY_ROUTINES[0]}\u00b7suffix`,
      `${WRITING_APPLY_ROUTINES[0]}\u200djoined`]) {
      expect(offending({ v: ordinary }), `${ordinary} is ordinary data and must pass`)
        .toBe(undefined);
    }
    for (const routine of WRITING_APPLY_ROUTINES) {
      expect(offending({ n: routine }),
        `${routine} is not statement-shaped by a \`select\` test and must still be found`)
        .toBe(routine);
    }
    // ...AND THE CONTAINERS, each read by its own branch.
    expect(offending({ m: new Map([['SELECT 1', 1]]) }), 'a MAP KEY is text').toBe('SELECT 1');
    expect(offending({ m: new Map([['safe', 'SELECT 1']]) }), 'a MAP VALUE is text too')
      .toBe('SELECT 1');
    expect(offending({ s: new Set(['SELECT 1']) }), 'a SET member is text').toBe('SELECT 1');
    expect(offending({ 'SELECT 1': true }), 'an OBJECT KEY is text').toBe('SELECT 1');
    const sym = Symbol('SELECT 1');
    expect(offending({ [sym]: true }), 'a SYMBOL-named property is text').toBe('SELECT 1');
    expect(offending({ v: Symbol('SELECT 1') }), 'a SYMBOL held as a VALUE is text too')
      .toBe('SELECT 1');
    expect(offending(Object.create({ sql: 'SELECT 1' })),
      'text on the PROTOTYPE is recoverable, and own-key traversal read none of it')
      .toBe('SELECT 1');
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic; cyclic.t = 'SELECT 1';
    expect(offending(cyclic), 'a cycle must not hang the walk, and must not hide the text')
      .toBe('SELECT 1');
    // ...AND AN OWN DATA PROPERTY LITERALLY NAMED `constructor` IS READ LIKE ANY OTHER. A round
    // found this walk skipping the VALUE at any key spelled `constructor`, on the theory that the
    // name always means "the intrinsic back-reference" — which is false for `Reflect.ownKeys`,
    // the only place this walk reads keys from: an INHERITED `constructor` is never an own key at
    // all, so a `constructor` seen here is always data a caller wrote. `{ constructor: { sql:
    // 'SELECT 1' } }` is exactly that, and it used to pass with the value never visited.
    expect(offending({ constructor: { sql: 'SELECT 1' } }),
      'an own data property named `constructor` must be read, not treated as a back-reference')
      .toBe('SELECT 1');
    // ...AND THE INHERITED `constructor` STILL CANNOT REACH THE INTRINSICS THROUGH IT, because
    // `Reflect.ownKeys` on an ordinary object never surfaces it in the first place — there is
    // nothing here for the removed special case to have been protecting.
    expect(offending({}), 'an ordinary object\'s inherited constructor must never surface as a '
      + 'text this walk visits').toBe(undefined);
    // ...AND THE KINDS IT CANNOT READ ARE REPORTED RATHER THAN SKIPPED.
    const withAccessor = {};
    Object.defineProperty(withAccessor, 'sql', { get: () => 'SELECT 1', enumerable: true });
    expect(walkExport(withAccessor).opaque,
      'an accessor is a property whose value this must not invoke and must not ignore')
      .toEqual(['export.sql: accessor']);
    const fn = () => undefined;
    Object.defineProperty(fn, 'sql', { value: 'SELECT 1' });
    expect(offending(fn), 'a FUNCTION carries own properties, and one used to be skipped whole')
      .toBe('SELECT 1');
    const onAMap = new Map<string, string>();
    Object.defineProperty(onAMap, 'sql', { value: 'SELECT 1' });
    expect(offending({ m: onAMap }), 'own properties of a Map were skipped by the container arm')
      .toBe('SELECT 1');
    // ...and a control, so the scan is not simply refusing everything.
    expect(offending({ ok: { deep: { er: 'an ordinary label' } } }),
      'ordinary exported data must pass').toBe(undefined);
    expect(walkExport({ ok: { deep: 1 } }).opaque, 'ordinary data has nothing opaque in it')
      .toEqual([]);
    // ...AND THE LOOP OVER THE REAL SURFACE RAN. Every assertion above is synthetic; deleting the
    // loop that applies the scan to the module would leave all of them green.
    expect(Object.entries(CATALOGUE).filter(([, v]) => typeof v !== 'function').length,
      'the scan must have a non-function export to walk, or it walked nothing')
      .toBeGreaterThan(0);
  });

  it('sends a statement whose digest is in the inventory, from EVERY entrypoint, and sends all of them',
    async () => {
      // ══ THE FACTORY'S BYTE-EQUALITY CONTROL, IN THE FORM A DIGEST INVENTORY ALLOWS ═════════
      //
      // Asked in BOTH directions, which is what the factory's own control learned to do: nothing
      // is sent whose digest is not in the inventory, and no inventory entry goes unsent. One
      // direction alone would miss a statement the module holds and never sends (audited by the
      // guard, never run by the server) or a statement assembled at call time (run by the server,
      // audited by nobody).
      //
      // THE CANONICAL EXAMPLES ARE THE MODULE'S OWN, and the LIMIT of that is worth stating: an
      // entrypoint that modified its constant on the way out — `.replace(…)`, a second render, a
      // concatenation — moves the sent bytes while the inventory stays put, and that is what this
      // catches. Editing the CONSTANT itself moves both together and stays green here; what
      // audits a constant's content is G3, through PostgreSQL's own grammar, and what audits its
      // MEANING is the database suite. This is the factory's byte-equality control in the form a
      // digest inventory allows, and it makes the factory's claim and no larger one.
      const { client, sent } = recordingClient();
      const canonical: Record<string, (c: never) => Promise<unknown>> = {
        applyNormalizedCore: (c) =>
          applyNormalizedCore(c, APPLY_CANONICAL_EXAMPLES.applyNormalizedCore),
        applyCommandAsActorReceiptPrivacy: (c) => applyCommandAsActorReceiptPrivacy(
          c, APPLY_CANONICAL_EXAMPLES.applyCommandAsActorReceiptPrivacy),
        applyCommandAsActorRefusalProbe: (c) => applyCommandAsActorRefusalProbe(
          c, APPLY_CANONICAL_EXAMPLES.applyCommandAsActorRefusalProbe),
        applyNormalizedCoreShaped: (c) => applyNormalizedCoreShaped(
          c, APPLY_CANONICAL_EXAMPLES.applyNormalizedCoreShaped),
        applyNormalizedCoreShapedExtend: (c) => applyNormalizedCoreShapedExtend(
          c, APPLY_CANONICAL_EXAMPLES.applyNormalizedCoreShapedExtend),
        applyCommandAsActorRenderedBarrier: (c) => applyCommandAsActorRenderedBarrier(
          c, APPLY_CANONICAL_EXAMPLES.applyCommandAsActorRenderedBarrier),
        applyCommandAsActorReachability: (c) => applyCommandAsActorReachability(
          c, APPLY_CANONICAL_EXAMPLES.applyCommandAsActorReachability),
      };
      // THE DRIVE LIST AND THE PINNED INVENTORY ARE THE SAME LIST, so an eighth entrypoint cannot
      // arrive with no case here.
      expect(Object.keys(canonical).sort()).toEqual([...APPLY_ENTRYPOINTS].sort());

      // NO COMPUTED MEMBER ACCESS ANYWHERE IN THIS FILE, and that is a rule rather than a style:
      // `checkScopeDrift` refuses any `abc27*` file outside the guard's program that obtains a
      // member it cannot show is not `query`, and it caught exactly this line the first time it
      // was written. A `Map` and an `Object.entries` walk say the same thing decidably.
      const digestOf = new Map<string, string>();
      const valuesOf = new Map<string, unknown[]>();
      for (const [name, drive] of Object.entries(canonical)) {
        sent.length = 0;
        await drive(client as never);
        // SIX OF THE SEVEN NOW ALSO READ BACK WHAT THEY STORED — dropped here by shape, so this
        // control keeps asking its own question: what the APPLY sent, byte for byte.
        const apply = withoutReadBack(sent);
        expect(apply, `${name} sent exactly one apply statement`).toHaveLength(1);
        digestOf.set(name, sha256(apply[0].text));
        valuesOf.set(name, apply[0].values);
      }
      // ── AND THE BOUND VALUES, WHICH THE DIGEST CANNOT SEE ────────────────────────────────
      //
      // A review round drew the line exactly: the digest is a claim about the STATEMENT, so
      // swapping two bound arguments — the actor for the academy, say — moves neither the text nor
      // its digest, and the whole control stayed green. The parameter lists are therefore stated
      // HERE, in the test, over the canonical arguments the module publishes; this is the one
      // assertion in this file that does not come from the module's own bytes.
      const EX = APPLY_CANONICAL_EXAMPLES;
      const FP = EX.applyNormalizedCore.fingerprintHex;
      expect(Object.fromEntries(valuesOf)).toEqual({
        applyNormalizedCore: [
          EX.applyNormalizedCore.actor, EX.applyNormalizedCore.academy, 'abc27.wire.v1', 'create',
          EX.applyNormalizedCore.command, EX.applyNormalizedCore.round, null, 'Catalogue',
          '2026-10-05', null, 2, 7, 0, 'deferred_split', false, 'inherit', false, false, null,
          true, null, null, null, null, null, null, null, [], [], [],
          EX.applyNormalizedCore.slots, EX.applyNormalizedCore.children,
          EX.applyNormalizedCore.targets, FP,
        ],
        applyCommandAsActorReceiptPrivacy: [
          EX.applyCommandAsActorReceiptPrivacy.academy,
          EX.applyCommandAsActorReceiptPrivacy.command,
          EX.applyCommandAsActorReceiptPrivacy.round,
          EX.applyCommandAsActorReceiptPrivacy.slots,
          EX.applyCommandAsActorReceiptPrivacy.children,
          EX.applyCommandAsActorReceiptPrivacy.targets, FP,
        ],
        applyCommandAsActorRefusalProbe: [],
        applyNormalizedCoreShaped: [
          EX.applyNormalizedCoreShaped.actor, EX.applyNormalizedCoreShaped.academy,
          EX.applyNormalizedCoreShaped.command, EX.applyNormalizedCoreShaped.round, FP,
        ],
        applyNormalizedCoreShapedExtend: [
          EX.applyNormalizedCoreShapedExtend.actor, EX.applyNormalizedCoreShapedExtend.academy,
          EX.applyNormalizedCoreShapedExtend.command, EX.applyNormalizedCoreShapedExtend.round, FP,
        ],
        applyCommandAsActorRenderedBarrier: [],
        applyCommandAsActorReachability: [
          EX.applyCommandAsActorReachability.academy, EX.applyCommandAsActorReachability.command,
          EX.applyCommandAsActorReachability.round, EX.applyCommandAsActorReachability.slots,
          EX.applyCommandAsActorReachability.children, EX.applyCommandAsActorReachability.targets,
          FP,
        ],
      });
      // (1) NOTHING SENT IS OUTSIDE THE INVENTORY — and it is the entrypoint's OWN digest, not
      //     merely some entry of the map, so two entrypoints cannot swap statements.
      expect(Object.fromEntries(digestOf)).toEqual({ ...APPLY_STATEMENT_DIGESTS });
      // (2) AND NO INVENTORY ENTRY GOES UNSENT.
      expect(Object.keys(APPLY_STATEMENT_DIGESTS).filter((n) => !digestOf.has(n))).toEqual([]);
    });
});

describe('ABC-27 apply catalogue — the frozen module is one whole authority', () => {
  // ══ WHY ONE WHOLE PIN, AND NOT A FIFTH FUNCTION-LOCAL RECOGNISER ═══════════════════════════
  //
  // The function-local source pins this file carried for the adapter's seven statements, the
  // seal's five arms, the boundary's two predicates and the six capture initializers were each
  // exact over the declaration they read and silent about the module around it. A terminal
  // review named the residue one hop out from each: a module-level `Buffer` whose
  // `prototype.toString` copies before encoding while every capture text stays exact; a default
  // parameter on `sealedElement` that taints the `where` every refusal message trusts; `sealed`
  // replacing `LOWER_HEX.test` with a bounded grammar, or reading a byte view before
  // `sealedValue` refuses it. Pinning those four would have moved the hole again. So the module
  // is pinned WHOLE, and those four pins are retired rather than extended. The resolved
  // query-argument and rendered-route pins the same review cleared remain below, as readings
  // within the module this authority holds — not as a second authority over it.
  //
  // THE DIGEST IS A LITERAL, NEVER DERIVED. `CATALOGUE_DIGEST` is the reviewed value written
  // down; nothing here reads the bytes to decide what the bytes should be. A legitimate change to
  // the frozen module is therefore an explicit act: the subject changes, the literal is replaced
  // with the digest of the reviewed bytes, and the change gets a fresh deep review. Version
  // control plus this pin are the change authority; no certifier is layered over it.
  //
  // WHAT THE PIN PROVES, AND ITS BOUNDARY. The bytes are read by `vi.hoisted`, before any import
  // of this file executes, so the digest is over the module as it was on disk before the
  // catalogue or any other imported module ran — a module that rewrote its own file on the way
  // in would be hashed as it was written, not as it left itself. The pin makes a change to the
  // frozen module VISIBLE and refuses it; it is not a defence against code already executing in
  // this process, which no assertion in a test can be.
  it('is byte-for-byte the reviewed module — the literal digest, never computed from the bytes it judges',
    () => {
      expect(CATALOGUE_DIGEST, 'the pin is a literal sha256 hex digest').toMatch(/^[0-9a-f]{64}$/);
      expect(CATALOGUE_BYTES.length, 'the bytes hashed are the bytes on disk, not an empty read')
        .toBeGreaterThan(0);
      expect(createHash('sha256').update(CATALOGUE_BYTES).digest('hex'),
        'the frozen catalogue module must be byte-for-byte the reviewed bytes; a legitimate '
        + 'change is an explicit repin of CATALOGUE_DIGEST plus a fresh deep review')
        .toBe(CATALOGUE_DIGEST);
      expect(CATALOGUE_TREE_IS_THE_BYTES,
        'the tree the structural pins read is the byte sequence the digest hashes').toBe(true);
    });

  it('declares exactly this surface and resolves every name it reads to its expected declaration',
    () => {
      // ══ THE SAME BYTES, READ THROUGH THE PROGRAM ═══════════════════════════════════════════
      //
      // The digest says the bytes are the reviewed bytes. This says what the reviewed bytes ARE,
      // in the two forms a reader can hold the module to without reading all of it: the closed
      // top-level surface — every import, declaration and export, in order, with what initialises
      // it — and a census of every identifier the module READS, each resolved by the TypeChecker
      // to the declaration that answers it. A module-local shadow of `Buffer`, `Array`, `Object`,
      // `Reflect`, `Uint8Array`, `ArrayBuffer` or of a captured intrinsic fails the digest and
      // the surface list, and a shadow of a name the module actually reads also stops resolving
      // to `<undeclared global>` in the census. The Program reads the same text the digest hashes
      // — the byte-pin control asserts it — so the pins are readings of one byte sequence.
      const surfaceOf = (statement: ts.Statement): string => {
        const modifiers = (ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [])
          .map((modifier) => modifier.getText(CATALOGUE_TREE));
        const prefix = modifiers.length > 0 ? `${modifiers.join(' ')} ` : '';
        if (ts.isImportDeclaration(statement)) {
          const clause = statement.importClause;
          const from = ts.isStringLiteral(statement.moduleSpecifier)
            ? statement.moduleSpecifier.text : '<non-literal specifier>';
          const parts: string[] = [];
          if (clause?.name !== undefined) parts.push(clause.name.text);
          const bindings = clause?.namedBindings;
          if (bindings !== undefined && ts.isNamedImports(bindings)) {
            parts.push(`{ ${bindings.elements.map((element) =>
              `${element.isTypeOnly ? 'type ' : ''}${element.propertyName === undefined ? ''
                : `${element.propertyName.text} as `}${element.name.text}`).join(', ')} }`);
          }
          if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
            parts.push(`* as ${bindings.name.text}`);
          }
          return `import ${clause?.isTypeOnly === true ? 'type ' : ''}${parts.join(', ')} `
            + `from '${from}'`;
        }
        if (ts.isVariableStatement(statement)) {
          const { flags } = statement.declarationList;
          const keyword = (flags & ts.NodeFlags.Const) !== 0 ? 'const'
            : (flags & ts.NodeFlags.Let) !== 0 ? 'let' : 'var';
          return `${prefix}${keyword} ${statement.declarationList.declarations.map((declaration) =>
            `${declaration.name.getText(CATALOGUE_TREE)}${declaration.initializer === undefined
              ? '' : ` = <${kindNameOf(declaration.initializer)}>`}`).join(', ')}`;
        }
        if (ts.isFunctionDeclaration(statement)) {
          return `${prefix}function ${statement.name?.text ?? '<anonymous>'}`;
        }
        if (ts.isTypeAliasDeclaration(statement)) return `${prefix}type ${statement.name.text}`;
        if (ts.isInterfaceDeclaration(statement)) {
          return `${prefix}interface ${statement.name.text}`;
        }
        return `<${kindNameOf(statement)}>`;
      };
      // ── AND NO TOP-LEVEL DECLARATION WEARS AN INTRINSIC'S NAME ───────────────────────────
      //
      // Every top-level binding — a variable or destructured name, a function, a class, an enum,
      // a type, an interface, a namespace, an import — is collected, and none may wear one of
      // the listed intrinsic names. The digest and the surface list refuse every shadow whatever
      // its name; this check exists so that a shadow of a name the module trusts is refused BY
      // NAME rather than only as a changed byte sequence.
      const declared = new Set<string>();
      const bindingNames = (name: ts.BindingName): string[] => (ts.isIdentifier(name)
        ? [name.text]
        : name.elements.flatMap((element) => (ts.isBindingElement(element)
          ? bindingNames(element.name) : [])));
      for (const statement of CATALOGUE_TREE.statements) {
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            for (const name of bindingNames(declaration.name)) declared.add(name);
          }
        }
        if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
          || ts.isEnumDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
          || ts.isInterfaceDeclaration(statement) || ts.isModuleDeclaration(statement)
          || ts.isImportEqualsDeclaration(statement)) && statement.name !== undefined) {
          declared.add(statement.name.getText(CATALOGUE_TREE));
        }
        if (ts.isImportDeclaration(statement)) {
          const clause = statement.importClause;
          if (clause?.name !== undefined) declared.add(clause.name.text);
          const bindings = clause?.namedBindings;
          if (bindings !== undefined && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) declared.add(element.name.text);
          }
          if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
            declared.add(bindings.name.text);
          }
        }
      }
      const INTRINSICS = ['Array', 'ArrayBuffer', 'Buffer', 'DataView', 'Date', 'Error',
        'Function', 'JSON', 'Map', 'Math', 'Number', 'Object', 'Promise', 'Proxy', 'Reflect',
        'RegExp', 'Set', 'SharedArrayBuffer', 'String', 'Symbol', 'Uint16Array', 'Uint8Array',
        'globalThis', 'undefined'];
      expect(INTRINSICS.filter((name) => declared.has(name)),
        'no module-level declaration may wear the name of an intrinsic').toEqual([]);

      // ── THE CENSUS: EVERY NAME THE MODULE READS, RESOLVED ────────────────────────────────
      const census = catalogueDependencies(CATALOGUE_TREE);
      expect(census.filter((label) => label.endsWith(':<undeclared global>'))
        .map((label) => label.slice(0, label.indexOf(':'))),
      'the only globals the catalogue reaches, each unshadowed, are these').toEqual([
        'Array', 'ArrayBuffer', 'Buffer', 'Date', 'Error', 'JSON', 'Number', 'Object', 'Promise',
        'PropertyKey', 'Readonly', 'Record', 'String', 'Uint8Array', 'undefined',
      ]);
      const RESOLVES_TO = /^[^:]+:(?:module-const|module-ambient-const|module-type|module-interface|import:.+|import-default:.+|parameter:.+|local:.+|type-parameter:.+|<undeclared global>)$/;
      expect(census.filter((label) => !RESOLVES_TO.test(label)),
        'every name the catalogue reads resolves to a module const, an import, a parameter, a '
        + 'local, a type parameter, a module type or interface, or an unshadowed global — nothing '
        + 'else, and no mutable module binding').toEqual([]);
      expect(census, 'every name the catalogue reads resolves to exactly these declarations')
        .toEqual([
          'APPLY_AS_ACTOR_REACHABILITY:module-const',
          'APPLY_AS_ACTOR_RECEIPT_PRIVACY:module-const',
          'APPLY_AS_ACTOR_REFUSAL_PROBE:module-const',
          'APPLY_AS_ACTOR_RENDERED_BARRIER:module-const',
          'APPLY_CANONICAL_EXAMPLES:module-const',
          'APPLY_NORMALIZED_CORE:module-const',
          'APPLY_NORMALIZED_CORE_SHAPED:module-const',
          'APPLY_NORMALIZED_CORE_SHAPED_EXTEND:module-const',
          'Array:<undeclared global>',
          'ArrayBuffer:<undeclared global>',
          'BUFFER_DETACHED:module-const',
          'BUFFER_RESIZABLE:module-const',
          'BUFFER_TO_STRING:module-const',
          'BarrierApplySpec:module-interface',
          'Buffer:<undeclared global>',
          'CANONICAL_BYTEA_HEX:module-ambient-const',
          'CANONICAL_UUID:module-const',
          'CanonicalByteaHex:module-type',
          'Date:<undeclared global>',
          'ELEMENT_SHAPE:module-const',
          'EX:module-const',
          'EX_CHILDREN:module-const',
          'EX_FINGERPRINT:module-const',
          'EX_HOLIDAY_FROM:module-const',
          'EX_HOLIDAY_LABEL:module-const',
          'EX_HOLIDAY_TO:module-const',
          'EX_SOURCES:module-const',
          'EX_TARGETS:module-const',
          'Error:<undeclared global>',
          'ExtendShapeSpec:module-interface',
          'ISO_DATE:module-const',
          'JSON:<undeclared global>',
          'LOWER_HEX:module-const',
          'NormalizedCoreArgs:module-interface',
          'Number:<undeclared global>',
          'Object:<undeclared global>',
          'PLAIN_LABEL:module-const',
          'Promise:<undeclared global>',
          'PropertyKey:<undeclared global>',
          'RENDERED_KINDS:module-const',
          'ReachabilityArgs:module-interface',
          'Readonly:<undeclared global>',
          'ReceiptPrivacyArgs:module-interface',
          'Record:<undeclared global>',
          'RefusalProbeArgs:module-interface',
          'RenderedArray:module-type',
          'RenderedElementType:module-type',
          'ShapedApplySpec:module-interface',
          'String:<undeclared global>',
          'T:type-parameter:sealed',
          'TYPED_ARRAY_PROTO:module-const',
          'Uint8Array:<undeclared global>',
          'VIEW_BUFFER:module-const',
          'a:local:applyCommandAsActorReachability',
          'a:local:applyCommandAsActorReceiptPrivacy',
          'a:local:applyCommandAsActorRefusalProbe',
          'a:local:applyNormalizedCore',
          'a:parameter:APPLY_AS_ACTOR_REFUSAL_PROBE',
          'a:parameter:renderArray',
          'a:parameter:uuidsOf',
          'args:parameter:applyCommandAsActorReachability',
          'args:parameter:applyCommandAsActorReceiptPrivacy',
          'args:parameter:applyCommandAsActorRefusalProbe',
          'args:parameter:applyNormalizedCore',
          'assertSlotsNotForeign:import:./abc27TrainerAuthority',
          'at:local:isIsoDate',
          'backing:local:canonicalByteaHexFromBytes',
          'byteaHexLiteral:module-const',
          'canonicalByteaHex:module-const',
          'canonicalTexts:module-const',
          'client:parameter:applyCommandAsActorReachability',
          'client:parameter:applyCommandAsActorReceiptPrivacy',
          'client:parameter:applyCommandAsActorRefusalProbe',
          'client:parameter:applyCommandAsActorRenderedBarrier',
          'client:parameter:applyNormalizedCore',
          'client:parameter:applyNormalizedCoreShaped',
          'client:parameter:applyNormalizedCoreShapedExtend',
          'createHash:import:node:crypto',
          'd:local:isIsoDate',
          'depth:parameter:sealedValue',
          'hex:local:canonicalByteaHexFromBytes',
          'i:local:sealedValue',
          'intrinsicGetter:module-const',
          'isAnyArrayBuffer:import:node:util/types',
          'isArrayBuffer:import:node:util/types',
          'isArrayBufferView:import:node:util/types',
          'isIsoDate:module-const',
          'isUint8Array:import:node:util/types',
          'key:local:sealedValue',
          'key:parameter:intrinsicGetter',
          'm:local:isIsoDate',
          'n:parameter:EX',
          'name:parameter:APPLY_STATEMENT_DIGESTS/anonymous#1',
          'noteSlotsOwned:import:./abc27TrainerAuthority',
          'o:parameter:sealed',
          'out:local:sealedValue',
          'owner:parameter:intrinsicGetter',
          'pg:import-default:pg',
          'quoted:local:renderArray',
          'renderArray:module-const',
          'result:local:applyCommandAsActorReachability',
          'result:local:applyCommandAsActorReceiptPrivacy',
          'result:local:applyCommandAsActorRenderedBarrier',
          'result:local:applyNormalizedCore',
          'result:local:applyNormalizedCoreShaped',
          'result:local:applyNormalizedCoreShapedExtend',
          'result:parameter:wasRefused',
          's:local:applyCommandAsActorRenderedBarrier',
          's:local:applyNormalizedCoreShaped',
          's:local:applyNormalizedCoreShapedExtend',
          's:parameter:APPLY_AS_ACTOR_RENDERED_BARRIER',
          's:parameter:APPLY_NORMALIZED_CORE_SHAPED',
          's:parameter:APPLY_NORMALIZED_CORE_SHAPED_EXTEND',
          'scalar:module-const',
          'sealed:module-const',
          'sealedElement:module-const',
          'sealedValue:module-const',
          'spec:parameter:applyCommandAsActorRenderedBarrier',
          'spec:parameter:applyNormalizedCoreShaped',
          'spec:parameter:applyNormalizedCoreShapedExtend',
          'text:parameter:APPLY_STATEMENT_DIGESTS/anonymous#1',
          'type:local:renderArray',
          'type:parameter:scalar',
          'undefined:<undeclared global>',
          'uuidLiteral:module-const',
          'uuidsOf:module-const',
          'v:parameter:isIsoDate',
          'v:parameter:quoted',
          'v:parameter:renderArray/anonymous#1',
          'v:parameter:renderArray/anonymous#2',
          'v:parameter:sealedValue',
          'v:parameter:uuidsOf/anonymous#1',
          'value:parameter:byteaHexLiteral',
          'value:parameter:canonicalByteaHex',
          'value:parameter:canonicalByteaHexFromBytes',
          'value:parameter:scalar',
          'value:parameter:uuidLiteral',
          'verifyStoredSlots:import:./abc27TrainerAuthority',
          'wasRefused:module-const',
          'where:parameter:canonicalByteaHex',
          'where:parameter:canonicalByteaHexFromBytes',
          'where:parameter:sealedElement',
          'where:parameter:sealedValue',
          'x:parameter:sealedElement',
          'y:local:isIsoDate',
        ]);

      expect(CATALOGUE_TREE.statements.map(surfaceOf),
        'the catalogue declares exactly this top-level surface, in this order').toEqual([
        'import { createHash } from \'node:crypto\'',
        'import { isAnyArrayBuffer, isArrayBuffer, isArrayBufferView, isUint8Array } '
          + 'from \'node:util/types\'',
        'import type pg from \'pg\'',
        'import { assertSlotsNotForeign, noteSlotsOwned, verifyStoredSlots } '
          + 'from \'./abc27TrainerAuthority\'',
        'const CANONICAL_UUID = <RegularExpressionLiteral>',
        'const ISO_DATE = <RegularExpressionLiteral>',
        'const isIsoDate = <ArrowFunction>',
        'const PLAIN_LABEL = <RegularExpressionLiteral>',
        'const LOWER_HEX = <RegularExpressionLiteral>',
        'export type RenderedElementType',
        'const ELEMENT_SHAPE = <CallExpression>',
        'const scalar = <ArrowFunction>',
        'export type RenderedArray',
        'const uuidLiteral = <ArrowFunction>',
        'const BUFFER_TO_STRING = <PropertyAccessExpression>',
        'declare const CANONICAL_BYTEA_HEX',
        'export type CanonicalByteaHex',
        'const canonicalByteaHex = <ArrowFunction>',
        'const TYPED_ARRAY_PROTO = <AsExpression>',
        'const intrinsicGetter = <ArrowFunction>',
        'const VIEW_BUFFER = <CallExpression>',
        'const BUFFER_RESIZABLE = <CallExpression>',
        'const BUFFER_DETACHED = <CallExpression>',
        'export const canonicalByteaHexFromBytes = <ArrowFunction>',
        'const byteaHexLiteral = <ArrowFunction>',
        'const RENDERED_KINDS = <CallExpression>',
        'const renderArray = <ArrowFunction>',
        'const uuidsOf = <ArrowFunction>',
        'const APPLY_NORMALIZED_CORE = <NoSubstitutionTemplateLiteral>',
        'const APPLY_AS_ACTOR_RECEIPT_PRIVACY = <NoSubstitutionTemplateLiteral>',
        'const APPLY_AS_ACTOR_REFUSAL_PROBE = <ArrowFunction>',
        'const APPLY_NORMALIZED_CORE_SHAPED = <ArrowFunction>',
        'const APPLY_NORMALIZED_CORE_SHAPED_EXTEND = <ArrowFunction>',
        'const APPLY_AS_ACTOR_RENDERED_BARRIER = <ArrowFunction>',
        'const APPLY_AS_ACTOR_REACHABILITY = <NoSubstitutionTemplateLiteral>',
        'const sealedElement = <ArrowFunction>',
        'const sealedValue = <ArrowFunction>',
        'const sealed = <ArrowFunction>',
        'const wasRefused = <ArrowFunction>',
        'export interface NormalizedCoreArgs',
        'export interface ReceiptPrivacyArgs',
        'export interface RefusalProbeArgs',
        'export interface ShapedApplySpec',
        'export interface ExtendShapeSpec',
        'export interface BarrierApplySpec',
        'export interface ReachabilityArgs',
        'export async function applyNormalizedCore',
        'export async function applyCommandAsActorReceiptPrivacy',
        'export async function applyCommandAsActorRefusalProbe',
        'export async function applyNormalizedCoreShaped',
        'export async function applyNormalizedCoreShapedExtend',
        'export async function applyCommandAsActorRenderedBarrier',
        'export async function applyCommandAsActorReachability',
        'const EX = <ArrowFunction>',
        'const EX_FINGERPRINT = <AsExpression>',
        'const EX_SOURCES = <ObjectLiteralExpression>',
        'const EX_CHILDREN = <ObjectLiteralExpression>',
        'const EX_TARGETS = <ObjectLiteralExpression>',
        'const EX_HOLIDAY_FROM = <ObjectLiteralExpression>',
        'const EX_HOLIDAY_TO = <ObjectLiteralExpression>',
        'const EX_HOLIDAY_LABEL = <ObjectLiteralExpression>',
        'export const APPLY_CANONICAL_EXAMPLES = <CallExpression>',
        'export const APPLY_ENTRYPOINTS = <CallExpression>',
        'const canonicalTexts = <ArrowFunction>',
        'export const APPLY_STATEMENT_DIGESTS = <CallExpression>',
      ]);
      expect(declared.size, 'the premise: the surface declares the names the census resolves to')
        .toBe(70);

    });
});

describe('ABC-27 apply catalogue — the registry is asked before anything is sent', () => {
  // ══ THE FOREIGN SLOT IS CLAIMED IN A HOOK, NOT BY THE FIRST TEST ═══════════════════════════
  //
  // It used to be minted and claimed by the first `it`, which every later case then relied on —
  // so running one of them alone, or reordering them, silently stopped testing a FOREIGN identity
  // at all. A review round named that. A `beforeAll` runs under the BOOTSTRAP identity, which no
  // test can ever be, so the id is foreign to every case here whatever order they run in and
  // however few of them do.
  beforeAll(() => {
    foreignSlot = randomUUID();
    noteSlotsOwned([foreignSlot]);
  });

  it('holds a slot under an identity no test can be, which is what makes it foreign', () => {
    expect(foreignSlot, 'the hook minted one').toMatch(/^[0-9a-f-]{36}$/);
    expect(slotOwner(foreignSlot), 'and it belongs to the bootstrap identity, not to any test')
      .toBe(BOOTSTRAP_IDENTITY);
    expect(currentIdentity()).not.toBe(BOOTSTRAP_IDENTITY);
  });

  it('refuses a FOREIGN source slot from every entrypoint that takes one, sending nothing',
    async () => {
      // ══ ONE CASE PER ENTRYPOINT, AND THE MATRIX IS THE SURFACE ═══════════════════════════
      //
      // Invoking an export is not the same as its check having run. Deleting the ownership check
      // from ONE entrypoint leaves the export pin unchanged, the digests unchanged and the
      // byte-equality control green, while a foreign source slot reaches the server and the
      // apply core derives that slot owner's trainer for the target rows it writes — the whole
      // indirect class, through a call that never names a trainer.
      //
      // `sent` IS ASSERTED EMPTY, not just the rejection: a check that ran AFTER the send would
      // reject just as loudly while the statement had already gone.
      const bySubject = drives({ slots: [foreignSlot], targets: [randomUUID()] });
      const slotless = new Set(['applyCommandAsActorRefusalProbe']);
      expect(Object.keys(bySubject).sort()).toEqual([...APPLY_ENTRYPOINTS].sort());
      for (const [name, drive] of Object.entries(bySubject)) {
        if (slotless.has(name)) continue;
        const { client, sent } = recordingClient();
        const outcome = await drive(client as never)
          .then(() => 'accepted', (e: Error) => e.message);
        expect(outcome, `${name} accepted a source slot this test does not own`)
          .toMatch(/is owned by/);
        expect(sent, `${name} sent something before refusing`).toEqual([]);
      }
    });

  it('refuses a FOREIGN target slot too, which is the other half of the same claim', async () => {
    // A TARGET IS A SLOT THIS TEST IS ABOUT TO WRITE. Claiming one another test already holds is
    // the same collision arriving from the other end, and `noteSlotsOwned` refuses it — before
    // the send, because it is the third of the four statements and the query is the fourth.
    const bySubject = drives({ slots: [randomUUID()], targets: [foreignSlot] });
    const slotless = new Set(['applyCommandAsActorRefusalProbe']);
    for (const [name, drive] of Object.entries(bySubject)) {
      if (slotless.has(name)) continue;
      const { client, sent } = recordingClient();
      const outcome = await drive(client as never).then(() => 'accepted', (e: Error) => e.message);
      expect(outcome, `${name} claimed a target slot another test owns`)
        .toMatch(/a slot belongs to one test/);
      expect(sent, `${name} sent something before refusing`).toEqual([]);
    }
  });

  it('refuses a foreign slot that arrives ONLY in the RENDERED array, and only in the PLAIN one',
    async () => {
      // ══ THE TWO HALVES OF THE GUARD, SEPARATED ═══════════════════════════════════════════
      //
      // Three entrypoints receive an identity list twice: as a plain array the registry judges and
      // as a RenderedArray whose elements reach the statement text. A review round pointed out
      // that the matrices above drive both from ONE array, so removing either half of the guard
      // left every case green — the other half carried the refusal. These two matrices put the
      // foreign id in exactly one of the two, so each half has a case only it can satisfy.
      // NO COMPUTED MEMBER ACCESS: `checkScopeDrift` refuses any `abc27*` file outside the
      // guard's program that obtains a member it cannot show is not `query`, and it caught this
      // loop the first time it was written — twice, in two different tests. `Object.entries` with
      // a predicate says the same thing decidably.
      const rendersIdentities = ([name]: [string, unknown]) =>
        name.includes('Shaped') || name.includes('RenderedBarrier');
      const onlyRendered = Object.entries(drives({
        slots: [randomUUID()], targets: [randomUUID()], renderedSources: [foreignSlot],
      })).filter(rendersIdentities);
      expect(onlyRendered.length,
        'the premise: some entrypoints render an identity list as well as passing one')
        .toBeGreaterThan(0);
      for (const [name, drive] of onlyRendered) {
        const { client, sent } = recordingClient();
        const outcome = await drive(client as never)
          .then(() => 'accepted', (e: Error) => e.message);
        expect(outcome, `${name} rendered a foreign source it never judged`).toMatch(/is owned by/);
        expect(sent, `${name} sent something before refusing`).toEqual([]);
      }

      for (const [name, drive] of Object.entries(drives({
        slots: [randomUUID()], targets: [randomUUID()], renderedTargets: [foreignSlot],
      })).filter(rendersIdentities)) {
        const { client, sent } = recordingClient();
        const outcome = await drive(client as never)
          .then(() => 'accepted', (e: Error) => e.message);
        expect(outcome, `${name} rendered a foreign target it never claimed`)
          .toMatch(/a slot belongs to one test/);
        expect(sent, `${name} sent something before refusing`).toEqual([]);
      }

      // ── AND THE PLAIN-ONLY DIRECTION, WHICH THE TITLE PROMISED AND THE BODY DID NOT DRIVE ──
      //
      // A review round found this half missing: with the foreign id only in the RENDERED array,
      // removing `s.slots` from the guard's first argument changed no verdict. Here it is only in
      // the PLAIN list, so the rendered half cannot carry the refusal.
      for (const [name, drive] of Object.entries(drives({
        slots: [foreignSlot], targets: [randomUUID()],
        renderedSources: [randomUUID()], renderedTargets: [randomUUID()],
      })).filter(rendersIdentities)) {
        const { client, sent } = recordingClient();
        const outcome = await drive(client as never)
          .then(() => 'accepted', (e: Error) => e.message);
        expect(outcome, `${name} took a foreign source it was handed directly`)
          .toMatch(/is owned by/);
        expect(sent, `${name} sent something before refusing`).toEqual([]);
      }
      for (const [name, drive] of Object.entries(drives({
        slots: [randomUUID()], targets: [foreignSlot],
        renderedSources: [randomUUID()], renderedTargets: [randomUUID()],
      })).filter(rendersIdentities)) {
        const { client, sent } = recordingClient();
        const outcome = await drive(client as never)
          .then(() => 'accepted', (e: Error) => e.message);
        expect(outcome, `${name} claimed a foreign target it was handed directly`)
          .toMatch(/a slot belongs to one test/);
        expect(sent, `${name} sent something before refusing`).toEqual([]);
      }

      // ...AND THE CONTROL FOR ALL FOUR: the same drives with NO foreign id anywhere are accepted,
      // so what refuses above is the foreign id and not the shape of the override.
      for (const [name, drive] of Object.entries(drives({
        slots: [randomUUID()], targets: [randomUUID()],
        renderedSources: [randomUUID()], renderedTargets: [randomUUID()],
      })).filter(rendersIdentities)) {
        const { client, sent } = recordingClient();
        await drive(client as never);
        expect(withoutReadBack(sent), `${name} must send when nothing is foreign`).toHaveLength(1);
      }
    });

  it('reads each argument ONCE, so an accessor cannot answer the check and the send differently',
    async () => {
      // ══ THE ROUND-1 P1, AS A RUNTIME CONTROL ═════════════════════════════════════════════
      //
      // The check and the send used to be two evaluations of the same property. An accessor that
      // returns `[]` the first time and a foreign slot the second satisfied one and supplied the
      // other — the getter shape this batch is supposed to be immune to, one layer further in.
      //
      // The guard now refuses a second read of the parameter syntactically. This is the other
      // half: the seal really does take ONE reading, so a two-faced accessor is judged on what it
      // answered rather than on what it answers next.
      let reads = 0;
      const twoFaced = {
        academy: randomUUID(), command: randomUUID(), round: randomUUID(),
        children: [randomUUID()], targets: [randomUUID()],
        fingerprintHex: FP_HEX,
        get slots() { reads += 1; return reads === 1 ? [] : [foreignSlot]; },
      };
      const { client, sent } = recordingClient();
      const outcome = await applyCommandAsActorReachability(client as never, twoFaced)
        .then(() => 'accepted', (e: Error) => e.message);
      expect(reads, 'the premise: the accessor was read at all').toBeGreaterThan(0);
      expect(reads, 'and it was read exactly once, which is what makes the answer binding').toBe(1);
      if (outcome === 'accepted') {
        // The single reading was the EMPTY one, so nothing foreign was checked and nothing
        // foreign may have been sent either.
        for (const { values } of sent) {
          expect(JSON.stringify(values).includes(foreignSlot),
            'the value the check never saw reached the server').toBe(false);
        }
      } else {
        expect(outcome).toMatch(/is owned by/);
        expect(sent).toEqual([]);
      }
    });

  // ══ THE BINARY BOUNDARY IS A PRIMITIVE, AND THESE ARE THE CONTROLS THAT SAY SO ═════════════
  //
  // WHAT USED TO BE HERE, AND WHY IT IS GONE. This block held eight controls defending a
  // caller-owned `Buffer`: a poisoned prototype answering the sealed copy's reads, a `Buffer`
  // disguised as a rendered array, an own `valueOf` redirecting `Buffer.from` onto attacker
  // memory, an own `Symbol.toPrimitive` boundary control, a private-exact-size backing store
  // against Node's shared pool, a bare prototype forgery, a `DataView` and a `Uint16Array` wearing
  // `Buffer.prototype`, and a genuine non-Buffer view. Every one of them is RETIRED, and none is
  // replaced by an equivalent, because the thing they defended is no longer in the contract: a
  // fingerprint arrives as a primitive string of canonical hex. A string cannot be mutated after
  // it is validated, has no prototype chain to trap, no `valueOf` to redirect a copy, no iterator,
  // and no backing store to alias — so the eight questions those controls asked have no subject.
  //
  // Their mutants are retired with them, for the same reason: `Buffer.copyBytesFrom`,
  // `Buffer.from(owned)` and the `ArrayBuffer.isView`/tag/`isBuffer` gate conjuncts are not code
  // that exists to mutate. What replaces all of it is smaller and asks about a primitive.

  it('takes a fingerprint only as a primitive string, refusing every binary shape', async () => {
    // TWO REFUSAL POINTS, WITH DIFFERENT ACCESS RULES. A `Buffer`, typed array, `DataView` or raw
    // `ArrayBuffer` is refused by the seal's internal-slot branch before a byte or property of that
    // binary shape is read. An ordinary object is instead sealed like ordinary data first — so an
    // own enumerable accessor on it CAN run once — and the resulting plain object, like
    // `undefined`, is then refused by `canonicalByteaHex`'s primitive-string test. None is sent.
    const shapes: ReadonlyArray<readonly [string, unknown]> = [
      ['a Buffer', Buffer.from('abc27', 'utf8')],
      ['a plain Uint8Array', new Uint8Array([0x61, 0x62])],
      ['a DataView', new DataView(new ArrayBuffer(4))],
      ['a raw ArrayBuffer', new ArrayBuffer(4)],
      ['an ordinary data object', { hex: FP_HEX }],
      ['undefined', undefined],
    ];
    for (const [label, value] of shapes) {
      const { client, sent } = recordingClient();
      const outcome = await applyNormalizedCore(client as never, {
        ...APPLY_CANONICAL_EXAMPLES.applyNormalizedCore,
        slots: [randomUUID()], targets: [randomUUID()], fingerprintHex: value,
      }).then(() => 'accepted', (e: Error) => e.message);
      expect(outcome, `${label} was accepted as a fingerprint`)
        .toMatch(/the binary boundary here takes a primitive string of canonical hex/);
      expect(withoutReadBack(sent), `${label} reached the wire`).toEqual([]);
    }
  });

  it('refuses hex that is not canonical, and accepts the empty value', async () => {
    // THE SHAPE IS CHECKED, THE LENGTH IS NOT. Upper case and an odd number of characters are
    // refused here; a 32-byte product rule is NOT, because that rule lives in the database and the
    // suite's own short-fingerprint case exists to watch PostgreSQL enforce it. The empty string
    // is a legitimate empty `bytea` and is accepted.
    for (const [label, value] of [
      ['upper case', '6162633237AB'], ['an odd length', '616'], ['a non-hex character', '61z2'],
    ] as ReadonlyArray<readonly [string, string]>) {
      const { client, sent } = recordingClient();
      const outcome = await applyNormalizedCore(client as never, {
        ...APPLY_CANONICAL_EXAMPLES.applyNormalizedCore,
        slots: [randomUUID()], targets: [randomUUID()], fingerprintHex: value,
      }).then(() => 'accepted', (e: Error) => e.message);
      expect(outcome, `${label} was accepted as canonical hex`).toMatch(/is not canonical hex/);
      expect(withoutReadBack(sent), `${label} reached the wire`).toEqual([]);
    }
    const { client, sent } = recordingClient();
    await applyNormalizedCore(client as never, {
      ...APPLY_CANONICAL_EXAMPLES.applyNormalizedCore,
      slots: [randomUUID()], targets: [randomUUID()], fingerprintHex: '',
    });
    expect(withoutReadBack(sent), 'an empty fingerprint is an empty bytea, and is sent')
      .toHaveLength(1);
  });

  it('binds the validated hex itself, without sending a client-side byte view', async () => {
    // WHAT WAS VALIDATED IS WHAT IS SENT. The bound value is the primitive string, unchanged and
    // uncopied, and the conversion to `bytea` happens in the STATEMENT — `pg_catalog.decode(…)` —
    // rather than in any client-side object that could differ from what was checked.
    const { client, sent } = recordingClient();
    await applyNormalizedCore(client as never, {
      ...APPLY_CANONICAL_EXAMPLES.applyNormalizedCore,
      slots: [randomUUID()], targets: [randomUUID()], fingerprintHex: FP_HEX,
    });
    const [apply] = withoutReadBack(sent);
    expect(apply.values.filter((v) => Buffer.isBuffer(v)),
      'no Buffer may reach the wire from this boundary any more').toEqual([]);
    expect(apply.values, 'the bound value is the validated primitive itself').toContain(FP_HEX);
  });

  it('refuses an invalid fingerprint from EVERY fingerprint-bearing entrypoint, sending nothing',
    async () => {
      // ══ THE BOUNDARY IS CROSSED SIX TIMES, AND EACH CROSSING IS DRIVEN ═══════════════════════
      //
      // The shapes and the grammar were driven through `applyNormalizedCore` alone, so an
      // entrypoint that bound its raw field instead of the validated value — a one-token change
      // in any of the other five — left every control here green while `'AA'` reached the wire.
      // A review round named it. Each entrypoint that takes a fingerprint is now driven with each
      // refused shape, and the drive list is compared against the pinned inventory minus the one
      // entrypoint that has no fingerprint at all.
      const refused: ReadonlyArray<readonly [string, unknown, RegExp]> = [
        ['a Buffer', Buffer.from('abc27', 'utf8'),
          /the binary boundary here takes a primitive string of canonical hex/],
        ['upper case', 'AA', /is not canonical hex/],
        ['an odd length', '616', /is not canonical hex/],
        ['a non-hex character', '61z2', /is not canonical hex/],
        ['undefined', undefined, /the binary boundary here takes a primitive string of canonical hex/],
      ];
      const bearing = [...APPLY_ENTRYPOINTS].filter((n) => n !== 'applyCommandAsActorRefusalProbe');
      for (const [label, value, pattern] of refused) {
        const bySubject = drives({
          slots: [randomUUID()], targets: [randomUUID()], fingerprintHex: value,
        });
        const driven = Object.entries(bySubject).filter(([name]) => bearing.includes(name));
        expect(driven.map(([name]) => name).sort(),
          'every fingerprint-bearing entrypoint is driven').toEqual([...bearing].sort());
        for (const [name, drive] of driven) {
          const { client, sent } = recordingClient();
          const outcome = await drive(client as never)
            .then(() => 'accepted', (e: Error) => e.message);
          expect(outcome, `${name} accepted ${label} as a fingerprint`).toMatch(pattern);
          expect(sent, `${name} sent something before refusing ${label}`).toEqual([]);
        }
      }
    });

  it('carries the fingerprint as pg_catalog.decode over the validated text in EVERY statement',
    async () => {
      // ══ THE DECODE FORM IS THE ROUTINE'S FINAL AST ARGUMENT, NOT TEXT NEARBY ═══════════════
      //
      // `decode($5,'hex')` is PostgreSQL-equivalent to `decode($5::text,'hex')` and the grammar
      // audit accepts both, so the every-statement claim was unsensed for the five bound
      // fingerprint statements — a review round pointed at exactly that edit. A substring check
      // was no better: the expected fragment could live in a SQL comment while the routine's real
      // final argument was something else. PostgreSQL's parser is now asked for the invoked
      // routine, and its actual final argument must be the exact qualified call below. The bound
      // parameter position is a PIN, stated here rather than derived from the module, for the
      // reason `HOLE_ORDER` below already gives: an expectation must not come from the thing it
      // judges. The sixth client fingerprint is rendered, not bound; the probe has none.
      const BOUND_POSITION = new Map<string, number>([
        ['applyNormalizedCore', 34], ['applyCommandAsActorReceiptPrivacy', 7],
        ['applyNormalizedCoreShaped', 5], ['applyNormalizedCoreShapedExtend', 5],
        ['applyCommandAsActorReachability', 7],
      ]);
      type PgRecord = Record<string, unknown>;
      const recordOf = (value: unknown): PgRecord | undefined =>
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? value as PgRecord : undefined;
      // ── THE WHOLE NODE, NOT A PROJECTION OF IT ──────────────────────────────────────────────
      //
      // A reader that lifted `funcname`, `args`, a cast's `names` and a constant's `sval` out of
      // the parser's JSON and compared THOSE was lossy in the certifying direction: `$34::text[]`
      // carries its bounds in `arrayBounds`, `decode(DISTINCT …)` its qualifier in
      // `agg_distinct`, `decode(…) OVER ()` its window in `over` — each a field the projection
      // never looked at, so each projected onto the accepted shape. A review round named all
      // three. Only source positions are stripped now; every other field the parser emitted must
      // equal the expected tree exactly, so a field this control has never heard of FAILS it.
      const withoutLocations = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(withoutLocations);
        const record = recordOf(value);
        if (record === undefined) return value;
        return Object.fromEntries(Object.entries(record)
          .filter(([key]) => key !== 'location')
          .map(([key, field]) => [key, withoutLocations(field)]));
      };
      const pgString = (sval: string) => ({ String: { sval } });
      const pgConst = (sval: string) => ({ A_Const: { sval: { sval } } });
      const pgParam = (number: number) => ({ ParamRef: { number } });
      const pgCast = (arg: unknown, type: string) =>
        ({ TypeCast: { arg, typeName: { names: [pgString(type)], typemod: -1 } } });
      const pgCall = (schema: string, routine: string, args: unknown[]) => ({
        FuncCall: {
          funcname: [pgString(schema), pgString(routine)], args,
          funcformat: 'COERCE_EXPLICIT_CALL',
        },
      });
      const writingRoutineOf = (node: unknown): string | undefined => {
        const call = recordOf(node);
        const parts = Array.isArray(call?.funcname) ? call.funcname : undefined;
        if (parts === undefined || parts.length !== 2) return undefined;
        const [schema, routine] = parts.map((part) => recordOf(recordOf(part)?.String)?.sval);
        return schema === 'public' && typeof routine === 'string'
          && WRITING_APPLY_ROUTINES.includes(routine) ? routine : undefined;
      };

      await loadOracle();
      const bySubject = drives({ slots: [randomUUID()], targets: [randomUUID()] });
      expect(Object.keys(bySubject).sort()).toEqual([...APPLY_ENTRYPOINTS].sort());
      for (const [name, drive] of Object.entries(bySubject)) {
        const { client, sent } = recordingClient();
        await drive(client as never);
        const [apply] = withoutReadBack(sent);
        expect(apply, `${name} sent one apply statement`).toBeTruthy();
        expect(apply.text.includes("'\\x"), `${name} carries a backslash bytea literal`).toBe(false);
        const parsed = parseSql(apply.text);
        expect(parsed.ok, `${name}: PostgreSQL must parse the statement whose shape is authoritative`)
          .toBe(true);
        if (!parsed.ok) continue;
        expect(parsed.stmts, `${name}: exactly one statement is sent`).toHaveLength(1);
        const routineCalls = (nodesOf(parsed.stmts, 'FuncCall') as unknown[])
          .filter((node) => writingRoutineOf(node) !== undefined);
        expect(routineCalls, `${name}: exactly one writing routine call is the statement`)
          .toHaveLength(1);
        const routine = recordOf(routineCalls[0]);
        expect(routine === undefined ? [] : Object.keys(routine).sort(),
          `${name}: the routine call itself carries no qualifier, window, filter or ordering`)
          .toEqual(['args', 'funcformat', 'funcname', 'location']);
        expect(routine?.funcformat, `${name}: the routine is an explicit call`)
          .toBe('COERCE_EXPLICIT_CALL');
        const routineArgs = Array.isArray(routine?.args) ? routine.args : [];
        const [finalArgument] = routineArgs.slice(-1);
        const at = BOUND_POSITION.get(name);
        if (at !== undefined) {
          expect(withoutLocations(finalArgument),
            `${name}: the routine's final argument must be exactly `
            + `pg_catalog.decode($${at}::text,'hex'), field for field`)
            .toEqual(pgCall('pg_catalog', 'decode', [pgCast(pgParam(at), 'text'), pgConst('hex')]));
          // `indexOf`, NOT `values[at - 1]`: a computed member is the one shape the sibling-scope
          // rule cannot show is not `.query`, and it refused this file for exactly that line.
          expect(apply.values.indexOf(FP_HEX), `${name} binds the validated hex at $${at}`)
            .toBe(at - 1);
        } else if (name === 'applyCommandAsActorRenderedBarrier') {
          expect(withoutLocations(finalArgument),
            'the rendered barrier final argument must be exactly pg_catalog.decode over the '
            + 'validated hex literal, field for field')
            .toEqual(pgCall('pg_catalog', 'decode', [pgConst(FP_HEX), pgConst('hex')]));
          expect(apply.values, 'and binds nothing').toEqual([]);
        } else {
          expect(name, 'the only entrypoint outside the pin is the fingerprint-free probe')
            .toBe('applyCommandAsActorRefusalProbe');
          expect(withoutLocations(finalArgument),
            'the probe final argument is exactly its server-minted value, not a client fingerprint')
            .toEqual(pgCall('pg_catalog', 'sha256', [pgCast(pgConst('x'), 'bytea')]));
        }
      }
      expect(BOUND_POSITION.size + 2, 'the pin covers the whole inventory')
        .toBe(APPLY_ENTRYPOINTS.length);
    });

  it('AST-pins every accepted fingerprint query argument and the rendered helper route to canonicalByteaHex',
    () => {
      // Runtime rejection drives show that invalid values are refused. They do not prove the
      // accepted expression handed to `.query` is the boundary's answer: a path could validate,
      // then bind its raw field, or inline the regexp and bypass the named boundary. Each bound
      // query's final values element is pinned here, and the rendered path is pinned through both
      // helper hops to the same `canonicalByteaHex` identifier.
      const BOUND = [
        ['applyNormalizedCore', 'APPLY_NORMALIZED_CORE', 34, 'a',
          "'the fingerprint applyNormalizedCore binds'"],
        ['applyCommandAsActorReceiptPrivacy', 'APPLY_AS_ACTOR_RECEIPT_PRIVACY', 7, 'a',
          "'the fingerprint applyCommandAsActorReceiptPrivacy binds'"],
        ['applyNormalizedCoreShaped', 'APPLY_NORMALIZED_CORE_SHAPED(s)', 5, 's',
          "'the fingerprint applyNormalizedCoreShaped binds'"],
        ['applyNormalizedCoreShapedExtend', 'APPLY_NORMALIZED_CORE_SHAPED_EXTEND(s)', 5, 's',
          "'the fingerprint applyNormalizedCoreShapedExtend binds'"],
        ['applyCommandAsActorReachability', 'APPLY_AS_ACTOR_REACHABILITY', 7, 'a',
          "'the fingerprint applyCommandAsActorReachability binds'"],
      ] as const;
      for (const [name, statement, valueCount, sealedName, where] of BOUND) {
        const declaration = catalogueFunction(name);
        const queries = declaration.body === undefined ? []
          : nodesMatching(declaration.body, ts.isCallExpression).filter((call) =>
            ts.isPropertyAccessExpression(call.expression)
            && call.expression.expression.getText(CATALOGUE_TREE) === 'client'
            && call.expression.name.text === 'query');
        expect(queries, `${name} must have exactly one direct client.query`).toHaveLength(1);
        const query = queries[0];
        expect(query?.arguments.length, `${name} sends statement and values`).toBe(2);
        expect(query?.arguments[0]?.getText(CATALOGUE_TREE), `${name} sends its pinned statement`)
          .toBe(statement);
        const values = query?.arguments[1];
        expect(values && ts.isArrayLiteralExpression(values),
          `${name} values must remain one array literal`).toBe(true);
        if (values === undefined || !ts.isArrayLiteralExpression(values)) continue;
        expect(values.elements, `${name} keeps the fingerprint at its pinned final position`)
          .toHaveLength(valueCount);
        const [fingerprint] = values.elements.slice(-1);
        expect(fingerprint && ts.isCallExpression(fingerprint),
          `${name} final query value must be a call`).toBe(true);
        if (fingerprint === undefined || !ts.isCallExpression(fingerprint)) continue;
        expect({
          callee: fingerprint.expression.getText(CATALOGUE_TREE),
          arguments: fingerprint.arguments.map((argument) => argument.getText(CATALOGUE_TREE)),
        }, `${name} must bind the named boundary's exact answer`).toEqual({
          callee: 'canonicalByteaHex',
          arguments: [`${sealedName}.fingerprintHex`, where],
        });
        // ...RESOLVED, not spelled: a local declaration wearing the boundary's name would keep
        // the pinned text and answer something else. The callee must resolve to the module's own
        // boundary, and the record it reads must be the entrypoint's sealed copy of its argument,
        // made by the module's own `sealed` in the entrypoint's first statement.
        expect(ts.isIdentifier(fingerprint.expression)
          ? catalogueAuthority(fingerprint.expression) : '<not an identifier callee>',
        `${name} must reach the module's own boundary, not a shadow of it`)
          .toBe('canonicalByteaHex:module-const');
        const argument = sealedName === 'a' ? 'args' : 'spec';
        const [sealing] = declaration.body?.statements ?? [];
        expect(sealing?.getText(CATALOGUE_TREE), `${name} seals its record first`)
          .toBe(`const ${sealedName} = sealed(${argument});`);
        expect(sealing === undefined ? [] : catalogueDependencies(sealing),
          `${name} seals its own argument through the module's own seal`)
          .toEqual([`${argument}:parameter:${name}`, 'sealed:module-const'].sort());
      }

      const barrier = catalogueFunction('applyCommandAsActorRenderedBarrier');
      const barrierQueries = barrier.body === undefined ? []
        : nodesMatching(barrier.body, ts.isCallExpression).filter((call) =>
          ts.isPropertyAccessExpression(call.expression)
          && call.expression.expression.getText(CATALOGUE_TREE) === 'client'
          && call.expression.name.text === 'query');
      expect(barrierQueries, 'the rendered barrier has exactly one direct client.query')
        .toHaveLength(1);
      expect(barrierQueries[0]?.arguments.map((argument) => argument.getText(CATALOGUE_TREE)),
        'the rendered barrier sends its helper output and binds nothing')
        .toEqual(['APPLY_AS_ACTOR_RENDERED_BARRIER(s)', '[]']);

      const renderer = catalogueVariable('APPLY_AS_ACTOR_RENDERED_BARRIER');
      expect(ts.isArrowFunction(renderer.initializer)
        && ts.isTemplateExpression(renderer.initializer.body),
      'the rendered statement must remain the inspected template').toBe(true);
      if (!ts.isArrowFunction(renderer.initializer)
        || !ts.isTemplateExpression(renderer.initializer.body)) return;
      const fingerprintRenders = nodesMatching(renderer.initializer.body, ts.isCallExpression)
        .filter((call) => call.expression.getText(CATALOGUE_TREE) === 'byteaHexLiteral');
      expect(fingerprintRenders.map((call) => ({
        callee: call.expression.getText(CATALOGUE_TREE),
        arguments: call.arguments.map((argument) => argument.getText(CATALOGUE_TREE)),
      })), 'the rendered statement sends its fingerprint through the named bytea helper')
        .toEqual([{ callee: 'byteaHexLiteral', arguments: ['s.fingerprintHex'] }]);
      const rendererSpans = renderer.initializer.body.templateSpans;
      const [finalRendererSpan] = rendererSpans.slice(-1);
      expect(finalRendererSpan?.expression.getText(CATALOGUE_TREE),
        'the fingerprint helper is the routine template\'s final argument')
        .toBe('byteaHexLiteral(s.fingerprintHex)');

      const [rendererCall] = fingerprintRenders;
      expect(rendererCall !== undefined && ts.isIdentifier(rendererCall.expression)
        ? catalogueAuthority(rendererCall.expression) : '<not an identifier callee>',
      'the rendered statement reaches the module\'s own bytea helper, not a shadow of it')
        .toBe('byteaHexLiteral:module-const');

      // ── THE HELPER IS PINNED WHOLE, NOT SAMPLED FOR ONE CALL ─────────────────────────────
      //
      // "It calls `canonicalByteaHex`" admitted `LOWER_HEX.test(value) ? value :
      // canonicalByteaHex(…)` — the expected call present, every accepted string routed around
      // it. A review round named it. The helper's ENTIRE declaration is the pin: one parameter,
      // a template body with exactly one span, that span exactly the boundary call, the pieces
      // around it exactly the decode form, and every name it depends on resolved.
      const literal = moduleConstArrow('byteaHexLiteral');
      expect(signatureShape(literal), 'byteaHexLiteral takes exactly the value to render').toEqual({
        async: false, typeParameters: 0,
        parameters: [
          { name: 'value', type: 'unknown', initializer: null, rest: false, optional: false },
        ],
        returnType: 'string',
      });
      const template = literal.body;
      expect(ts.isTemplateExpression(template), 'byteaHexLiteral is one template expression')
        .toBe(true);
      if (!ts.isTemplateExpression(template)) return;
      expect({
        head: template.head.text,
        spans: template.templateSpans.map((span) => ({
          expression: span.expression.getText(CATALOGUE_TREE),
          isDirectCall: ts.isCallExpression(span.expression)
            && ts.isIdentifier(span.expression.expression)
            && span.expression.arguments.every((argument) =>
              ts.isIdentifier(argument) || ts.isStringLiteral(argument)),
          literal: span.literal.text,
        })),
      }, 'byteaHexLiteral renders exactly the decode form over the boundary\'s own answer')
        .toEqual({
          head: "pg_catalog.decode('",
          spans: [{
            expression: "canonicalByteaHex(value, 'a rendered bytea literal')",
            isDirectCall: true,
            literal: "','hex')",
          }],
        });
      expect(catalogueDependencies(template),
        'byteaHexLiteral depends on the boundary and its own parameter, and nothing else')
        .toEqual(['canonicalByteaHex:module-const', 'value:parameter:byteaHexLiteral']);
      expect([...BOUND.map(([name]) => name), 'applyCommandAsActorRenderedBarrier',
        'applyCommandAsActorRefusalProbe'].sort(),
      'five bound routes, one rendered route and the fingerprint-free probe cover the inventory')
        .toEqual([...APPLY_ENTRYPOINTS].sort());
    });

  it('never formats a refused fingerprint into its message', async () => {
    // A message that interpolated the value would be a second reading of it, and on the grammar
    // branch the value is whatever text the caller chose. Adding `${value}` to that message left
    // every regex control here green — a review round named it — so a unique sentinel is refused
    // on the bound path and on the rendered path, and neither message may carry it. The other
    // refusal branch is driven separately with an ordinary object carrying distinct key and value
    // markers: formatting that object, its fields or its value must reveal none of them.
    const sentinel = `zz-sentinel-${randomUUID()}`;
    const { client, sent } = recordingClient();
    const bound = await applyNormalizedCore(client as never, {
      ...APPLY_CANONICAL_EXAMPLES.applyNormalizedCore,
      slots: [randomUUID()], targets: [randomUUID()], fingerprintHex: sentinel,
    }).then(() => 'accepted', (e: Error) => e.message);
    expect(bound).toMatch(/is not canonical hex/);
    expect(bound.includes(sentinel), 'the refused value was formatted into the message').toBe(false);
    const rendered = await applyCommandAsActorRenderedBarrier(client as never, {
      academy: randomUUID(), round: randomUUID(), fingerprintHex: sentinel,
      slots: [], targets: [randomUUID()],
      sources: list([randomUUID()]), children: list([randomUUID()]), targetArray: list([randomUUID()]),
    }).then(() => 'accepted', (e: Error) => e.message);
    expect(rendered).toMatch(/is not canonical hex/);
    expect(rendered.includes(sentinel), 'the rendered path formatted the refused value').toBe(false);
    const objectKey = `object-key-${randomUUID()}`;
    const objectValue = `object-value-${randomUUID()}`;
    const objectMarker = `object-marker-${randomUUID()}`;
    const distinctive = { [objectKey]: objectValue, [objectMarker]: { value: objectValue } };
    const nonString = await applyNormalizedCore(client as never, {
      ...APPLY_CANONICAL_EXAMPLES.applyNormalizedCore,
      slots: [randomUUID()], targets: [randomUUID()], fingerprintHex: distinctive,
    }).then(() => 'accepted', (e: Error) => e.message);
    expect(nonString).toMatch(/takes a primitive string of canonical hex/);
    for (const secret of [objectKey, objectValue, objectMarker]) {
      expect(nonString.includes(secret), `the non-string refusal disclosed ${secret}`).toBe(false);
    }
    expect(sent).toEqual([]);
    // ...and the adapter names a SHAPE when it refuses, never the bytes it was handed.
    let adapterMessage = '<not thrown>';
    try { canonicalByteaHexFromBytes(new Uint16Array([0x1122]), 'a driver value'); }
    catch (e) { adapterMessage = (e as Error).message; }
    expect(adapterMessage).toMatch(/not a genuine Uint8Array byte view/);
    expect(/1122|4386|\[object/.test(adapterMessage), 'the adapter formatted the value').toBe(false);
    // The SHAPE of every refusal — string pieces and template spans over the trusted field label,
    // nothing value-derived, and no default parameter or helper that could taint that label —
    // is held by the whole-module authority above: the reviewed bytes of every throw are pinned,
    // and a change to any of them is a repin and a fresh review, not a sample here.
  });

  it('binds canonical hex of any length — the 32-byte rule is the database\'s, not this file\'s',
    async () => {
      // `value.length > 64` added to the refusal left every control green, because every driven
      // fingerprint was 32 bytes or shorter. The claim is that the length is NOT this file's rule,
      // so a longer canonical value must cross the boundary on both paths.
      for (const bytes of [33, 100]) {
        const hex = Buffer.alloc(bytes, 0xab).toString('hex');
        const { client, sent } = recordingClient();
        await applyNormalizedCore(client as never, {
          ...APPLY_CANONICAL_EXAMPLES.applyNormalizedCore,
          slots: [randomUUID()], targets: [randomUUID()], fingerprintHex: hex,
        });
        const [apply] = withoutReadBack(sent);
        expect(apply.values[33], `${bytes} bytes of canonical hex must cross the boundary`).toBe(hex);
        const probe = recordingClient();
        await applyCommandAsActorRenderedBarrier(probe.client as never, {
          academy: randomUUID(), round: randomUUID(), fingerprintHex: hex,
          slots: [], targets: [randomUUID()],
          sources: list([randomUUID()]), children: list([randomUUID()]),
          targetArray: list([randomUUID()]),
        });
        expect(probe.sent[0].text, `${bytes} bytes must render as a decode() call`)
          .toContain(`pg_catalog.decode('${hex}','hex')`);
      }
    });

  it('refuses a binary buffer or view at the seal, without reading a byte or a property of it',
    async () => {
      // ══ THE SEAL USED TO READ EVERY BYTE OF A BUFFER BEFORE THE BOUNDARY REFUSED IT ═════════
      //
      // A `Buffer` is an object whose own enumerable properties are its bytes, so the seal's
      // object branch copied all of them — and an enumerable accessor a caller attached ran
      // inside the seal, on a value the boundary was about to refuse. A review round measured the
      // accessor firing. The seal now asks two internal-slot questions first and refuses without
      // touching the value; the accessor's own counter is the proof.
      let reads = 0;
      const shapes: ReadonlyArray<readonly [string, () => object]> = [
        ['a Buffer', () => Buffer.from('abc27', 'utf8')],
        ['a Uint8Array', () => new Uint8Array([1, 2])],
        ['a Uint16Array', () => new Uint16Array([0x1122])],
        ['a DataView', () => new DataView(new ArrayBuffer(4))],
        ['an ArrayBuffer', () => new ArrayBuffer(4)],
        ['a SharedArrayBuffer', () => new SharedArrayBuffer(4)],
      ];
      for (const [label, make] of shapes) {
        const value = make();
        // An enumerable accessor, and OWN accessors wearing the names a byte-view read would ask
        // for — `byteLength` and `length` — so a read of either ahead of the refusal counts too.
        for (const key of ['spy', 'byteLength', 'length']) {
          Object.defineProperty(value, key,
            { configurable: true, enumerable: key === 'spy', get() { reads += 1; return 'x'; } });
        }
        const { client, sent } = recordingClient();
        const outcome = await applyCommandAsActorReachability(client as never, {
          academy: randomUUID(), command: randomUUID(), round: randomUUID(),
          slots: [randomUUID()], children: [randomUUID()], targets: [randomUUID()],
          fingerprintHex: value,
        }).then(() => 'accepted', (e: Error) => e.message);
        expect(outcome, `${label} was not refused at the seal`)
          .toMatch(/refused at the seal, before any of its bytes or properties are read/);
        expect(sent, `${label} reached the wire`).toEqual([]);
      }
      expect(reads, 'an own accessor — enumerable or not — on a refused binary shape must never run')
        .toBe(0);
      // ...AND IN ANY FIELD, not only the fingerprint: the seal is total over the record.
      const { client, sent } = recordingClient();
      const elsewhere = await applyCommandAsActorReachability(client as never, {
        academy: Buffer.from('ab'), command: randomUUID(), round: randomUUID(),
        slots: [randomUUID()], children: [randomUUID()], targets: [randomUUID()],
        fingerprintHex: FP_HEX,
      }).then(() => 'accepted', (e: Error) => e.message);
      expect(elsewhere).toMatch(/refused at the seal/);
      expect(sent).toEqual([]);
      // WHAT RUNS BEFORE THE REFUSAL — in `sealedValue`, and in the `sealed` wrapper ahead of it
      // — is held by the whole-module authority above, which pins every byte of both; the
      // accessor counter here is the runtime half, and it is not the pin.
    });

  it('answers from the intrinsics it captured, not from a live prototype',
    async () => {
      // ══ CAPTURE, PROVED BY TAMPERING AFTER IMPORT ═══════════════════════════════════════════
      //
      // The controls below cannot tell a captured intrinsic from a live lookup — both answer the
      // same on an untouched prototype — so a `Buffer.prototype.toString.call(…)` written at
      // conversion time would pass them while consulting whatever the prototype holds NOW. A
      // review round named it. Each intrinsic the adapter captured is replaced with one that
      // records and throws, the adapter is driven, and it must answer from what it captured. The
      // window is kept to the adapter call alone and the descriptors are restored whatever happens.
      const source = Buffer.from('abc27', 'utf8');
      const tampered: string[] = [];
      // TWO REALMS, TAMPERED BOTH. The unit environment can hand the module one realm's
      // `Uint8Array`/`ArrayBuffer` intrinsics while a `Buffer` instance's own prototype chain
      // reaches Node's — the first run of this control found exactly that: the global chain was
      // tampered and the instance's chain was not, so `source.buffer` answered untripped. The
      // adapter captured the globals' getters; a live lookup would walk the instance's chain. Both
      // are replaced, so a live lookup trips whichever chain it walks and the captured getters
      // still answer. The backing store is read ONCE, before anything is tampered, only to reach
      // its realm's prototype.
      const chainOf = (o: object) => Object.getPrototypeOf(o) as object;
      const typedProtos = new Set<object>([chainOf(Uint8Array.prototype), chainOf(chainOf(Buffer.prototype))]);
      const backingOf = source.buffer;
      const abProtos = new Set<object>([ArrayBuffer.prototype, chainOf(backingOf)]);
      const own = (o: object, k: string) => Object.getOwnPropertyDescriptor(o, k);
      const restore: Array<() => void> = [];
      const tamper = (o: object, k: string, d: PropertyDescriptor) => {
        const s = own(o, k);
        Object.defineProperty(o, k, d);
        restore.push(s ? () => { Object.defineProperty(o, k, s); } : () => { Reflect.deleteProperty(o, k); });
      };
      const trap = (name: string) => function tripped() {
        tampered.push(name); throw new Error(`live lookup of ${name}`);
      };
      let answered = '<not answered>';
      try {
        tamper(Buffer.prototype, 'toString',
          { ...own(Buffer.prototype, 'toString'), value: trap('Buffer.prototype.toString') });
        for (const p of typedProtos) {
          tamper(p, 'buffer', { ...own(p, 'buffer'), get: trap('%TypedArray%.prototype.buffer') });
        }
        for (const p of abProtos) {
          tamper(p, 'detached', { ...own(p, 'detached'), get: trap('ArrayBuffer.prototype.detached') });
          tamper(p, 'resizable', { ...own(p, 'resizable'), get: trap('ArrayBuffer.prototype.resizable') });
        }
        // THE TAMPERING IS REAL: a live use of any of them, on the instance's own chain, now trips.
        expect(() => source.toString('hex')).toThrow(/live lookup of Buffer\.prototype\.toString/);
        expect(() => source.buffer).toThrow(/live lookup of %TypedArray%/);
        // The project's TypeScript lib predates `ArrayBuffer.prototype.detached`, exactly as the
        // resizable control above notes for its constructor, so the getter is reached through a
        // typed alias rather than by widening the whole file's lib setting.
        const attached = backingOf as unknown as { readonly detached: boolean };
        expect(() => attached.detached).toThrow(/live lookup of ArrayBuffer\.prototype\.detached/);
        tampered.length = 0;
        answered = canonicalByteaHexFromBytes(source, 'a driver value');
      } finally {
        for (const r of restore.reverse()) r();
      }
      expect(answered, 'the adapter must answer from what it captured').toBe(FP_HEX);
      expect(tampered, 'the adapter consulted a live prototype instead of what it captured')
        .toEqual([]);
      // A COPY IS NOT OBSERVABLE — `new Uint8Array(view)` copies from internal slots and runs no
      // hook — so what the adapter and its module-load captures ARE is not sampled here: the
      // whole-module authority above pins every byte of the adapter, of every capture initializer
      // and of everything else at module level, a private `Buffer` included.
    });

  // ══ THE ONE PLACE A BYTE VIEW IS STILL READ: WHAT THE DRIVER HANDS BACK ════════════════════
  //
  // `bytea` comes back from `node-postgres` as a byte view, so converting it into the boundary's
  // currency is a real need. `canonicalByteaHexFromBytes` is that conversion and the only one, and
  // it asks internal-slot questions — `isUint8Array`, `isArrayBuffer`, and the captured
  // `resizable`/`detached` getters — rather than the `instanceof`, `ArrayBuffer.isView` and
  // `Object.prototype.toString` tag tests that five review rounds defeated in turn.
  it('converts a driver byte view to canonical hex, byte-exactly, without consulting a caller-controlled property or invoking caller code',
    async () => {
      const hostile = Buffer.from('abc27', 'utf8');
      // A `Map`, NOT `calls[k]`. An element access with a computed key is something the
      // sibling-scope rule cannot show is not `.query`, and it refused this whole file for exactly
      // that spelling once already.
      const calls = new Map<string, number>();
      const count = (k: string) => { calls.set(k, (calls.get(k) ?? 0) + 1); };
      for (const key of ['valueOf', 'toString', 'constructor'] as const) {
        Object.defineProperty(hostile, key, { configurable: true, get() { count(key); return () => 'x'; } });
      }
      Object.defineProperty(hostile, Symbol.toPrimitive,
        { configurable: true, get() { count('toPrimitive'); return () => 'x'; } });
      Object.defineProperty(hostile, Symbol.iterator,
        { configurable: true, get() { count('iterator'); return function* () { yield 0; }; } });
      Object.setPrototypeOf(hostile, new Proxy(Object.create(null), {
        getPrototypeOf() { count('getPrototypeOf'); return Buffer.prototype; },
      }));

      expect(canonicalByteaHexFromBytes(hostile, 'a driver value'),
        'a genuine Buffer must convert byte-exactly').toBe(FP_HEX);
      expect([...calls.keys()], 'the conversion read something the caller controls').toEqual([]);
      // ...and a plain, authentic Uint8Array means the same bytes, since the slot is what is read.
      expect(canonicalByteaHexFromBytes(new Uint8Array([0x61, 0x62, 0x63, 0x32, 0x37]), 'a driver value'))
        .toBe(FP_HEX);
      expect(canonicalByteaHexFromBytes(new Uint8Array(0), 'an empty driver value')).toBe('');
    });

  it('refuses every value that only LOOKS like a driver byte view', async () => {
    const forgeries: ReadonlyArray<readonly [string, unknown]> = [
      ['a bare prototype object', Object.create(Buffer.prototype)],
      ['a Uint16Array', new Uint16Array([0x1122])],
      ['a DataView', new DataView(new ArrayBuffer(2))],
      ['a Proxy-wrapped view', new Proxy(new Uint8Array([1, 2]), {})],
      ['a plain object', { length: 2, 0: 1, 1: 2 }],
    ];
    const spoofed = new DataView(new ArrayBuffer(2));
    Object.setPrototypeOf(spoofed, Buffer.prototype);
    Object.defineProperty(spoofed, Symbol.toStringTag, { configurable: true, value: 'Uint8Array' });
    for (const [label, value] of [...forgeries, ['a DataView with a spoofed tag', spoofed] as const]) {
      expect(() => canonicalByteaHexFromBytes(value, 'a driver value'), `${label} was converted`)
        .toThrow(/not a genuine Uint8Array byte view/);
    }
  });

  it('refuses a shared, detached or resizable backing store', async () => {
    // EACH IS A DIFFERENT WAY FOR THE BYTES TO NOT BE THE BYTES THAT WERE CHECKED: another thread
    // can rewrite shared memory, a detached buffer reads as empty rather than as the failure it
    // is, and a resizable one need not still be the length that was measured.
    expect(() => canonicalByteaHexFromBytes(new Uint8Array(new SharedArrayBuffer(4)), 'v'))
      .toThrow(/shared memory/);
    // The project's TypeScript lib predates resizable ArrayBuffers, so the constructor is
    // reached through a typed alias rather than by widening the whole file's lib setting.
    const Resizable = ArrayBuffer as unknown as {
      new (byteLength: number, options: { maxByteLength: number }): ArrayBuffer;
    };
    const resizable = new Uint8Array(new Resizable(4, { maxByteLength: 8 }));
    expect(() => canonicalByteaHexFromBytes(resizable, 'v')).toThrow(/resizable/);
    const backing = new ArrayBuffer(4);
    const detachedView = new Uint8Array(backing);
    structuredClone(backing, { transfer: [backing] });
    expect(() => canonicalByteaHexFromBytes(detachedView, 'v')).toThrow(/detached/);
  });

  it('returns a value the source can no longer change', async () => {
    // THE CONVERSION'S RESULT IS A PRIMITIVE, so "does it still track its source" is answerable
    // once and for all rather than per copy strategy: writing the source, or its whole backing
    // store, cannot reach a string.
    const source = Buffer.from('abc27', 'utf8');
    const hex = canonicalByteaHexFromBytes(source, 'a driver value');
    source.fill(0x00);
    new Uint8Array(source.buffer).fill(0xff);
    expect(hex, 'the converted value changed when its source did').toBe(FP_HEX);
  });

  it('refuses an identity element that is not a string, which the registry would skip', async () => {
    // ══ A VALUE THE CHECK IGNORES AND THE DRIVER SERIALIZES ═════════════════════════════════
    //
    // `assertSlotsNotForeign` deliberately ignores a non-string element — several fixtures pass a
    // `null` or a ghost on purpose — while `node-postgres` calls a value's own `toPostgres()` when
    // it has one. A review round supplied `{ toPostgres: () => <a foreign slot> }` as a source
    // slot: checked as nothing, sent as that slot. The catalogue refuses a non-string identity at
    // its own boundary rather than asking the frozen registry to change what it ignores.
    const hostile: ReadonlyArray<readonly [string, unknown]> = [
      ['an object carrying its own serializer', { toPostgres: () => foreignSlot }],
      ['a bare object', { id: foreignSlot }],
      ['a number', 7],
      ['a nested array', [foreignSlot]],
      ['a function', () => foreignSlot],
      // ── AND THE HOLE, which used to be waved through as though it were the deliberate `null`
      //
      // `undefined` was accepted by the same arm as `null`. `node-postgres` sends an undefined
      // array member as SQL `NULL`, so an element nobody decided on arrived indistinguishable
      // from one somebody did — and a hole in an array is far more often a missed lookup than a
      // decision. The deliberate absence already has a spelling, and it is the one below.
      ['a hole', undefined],
    ];
    for (const [label, element] of hostile) {
      const { client, sent } = recordingClient();
      const outcome = await applyCommandAsActorReachability(client as never, {
        academy: randomUUID(), command: randomUUID(), round: randomUUID(),
        slots: [element] as never, children: [randomUUID()], targets: [randomUUID()],
        fingerprintHex: FP_HEX,
      }).then(() => 'accepted', (e: Error) => e.message);
      expect(outcome, `${label} was accepted as an identity`)
        .toMatch(/is not a string|is a function|is `undefined`/);
      expect(sent, `${label} reached the server`).toEqual([]);
    }
    // ...AND THE `null` A FIXTURE REALLY DOES PASS IS STILL ACCEPTED, so the rule is about values
    // the driver can turn into something and not a ban on the absent one.
    const { client, sent } = recordingClient();
    await applyCommandAsActorReachability(client as never, {
      academy: randomUUID(), command: randomUUID(), round: randomUUID(),
      slots: [null] as never, children: [randomUUID()], targets: [randomUUID()],
      fingerprintHex: FP_HEX,
    });
    expect(withoutReadBack(sent),
      'a deliberate null identity is a fixture value, not a smuggled one').toHaveLength(1);
  });

  it('accepts the ONE entrypoint entitled to guard no slots, and it is the only one', async () => {
    // ══ THE `(guarding no slots)` ENTITLEMENT, AS A TYPE RATHER THAN A LABEL ═════════════════
    //
    // Its predecessor was a STRING a reader recovered from the guard call and matched against an
    // allow-list of labels. It is a shape now: the refusal-matrix arm mints every array with
    // `gen_random_uuid()` INSIDE the statement, so it genuinely has no client-minted slot, and
    // its argument record has no slot field at all — there is nothing to pass and nothing to
    // forget. Every other entrypoint's record requires one, which is a compile-time fact; this
    // pins the runtime half, and G3-c pins the one-entry entitlement in the guard.
    const { client, sent } = recordingClient();
    // THE CANONICAL ACADEMY, because this entrypoint RENDERS it: its digest is taken over the
    // canonical example, so comparing bytes means driving the same arguments. Driving it twice is
    // free precisely because it claims nothing, which is the other half of what this asserts.
    await applyCommandAsActorRefusalProbe(
      client as never, APPLY_CANONICAL_EXAMPLES.applyCommandAsActorRefusalProbe);
    expect(sent, 'the refusal probe sends its statement with no slot to check').toHaveLength(1);
    expect(sha256(sent[0].text))
      .toBe(APPLY_STATEMENT_DIGESTS.applyCommandAsActorRefusalProbe);
    // ...AND IT CLAIMS NOTHING IT WAS GIVEN. A review round pointed out that the assertion this
    // replaces claimed a fresh id of its own and re-claimed it, which is true of any identity and
    // says nothing about the probe. What is observable is the probe's own argument: after the
    // drive, the academy it rendered is owned by nobody. The stronger half — that it may not claim
    // ANYTHING, including a value it invented — is a shape rather than an observation, and the
    // guard pins it: the one no-slot entitlement covers both halves of the guard sequence, so
    // `noteSlotsOwned` there must be a literal empty array.
    expect(slotOwner(APPLY_CANONICAL_EXAMPLES.applyCommandAsActorRefusalProbe.academy),
      'the refusal probe claimed the one identity it was given').toBeUndefined();
  });
});

describe('ABC-27 apply catalogue — a rendered value cannot change what the statement IS', () => {
  it('refuses every hostile value a renderer could be handed, and sends nothing', async () => {
    // ══ WHY A RENDERED HOLE IS NOT AN INTERPOLATION ══════════════════════════════════════════
    //
    // FOUR of the seven statements carry holes, and the reason has been stated wrongly twice.
    // MEASURED: `pg` DOES express a multidimensional array (`[['a'],['b']]` → `{{"a"},{"b"}}`, a
    // NULL member → `{"a",NULL}`), and it passes a STRING through untouched, so
    // `prepareValue('[0:1]={a,b}')` binds a non-one-based array as text. The true statement is
    // that a native JavaScript `Array` does not PRESERVE a lower bound, the bound not being part
    // of the value; rendering is how three of these statements get one, and the other shapes are
    // rendered alongside for uniformity rather than from necessity. The fourth, the refusal
    // probe, renders one UUID and could have been parameterised.
    // The SHAPES are what
    // the replay-shape controls are about. G3 proves each hole is a direct call of a named
    // private renderer; this proves what a renderer does with a value it should never see.
    //
    // A VALIDATED SCALAR CANNOT CARRY A QUOTE, A BRACKET, A COMMA OR A PAREN — so it cannot close
    // one array and open another, cannot append a set operation, cannot reach a second argument
    // position. Each input below is one of those escapes, and each is a THROW rather than a
    // quoted rendering: a validator that sanitises is a validator to defeat, and there is nothing
    // to defeat when the only alternative to the shape is no call at all.
    const HOSTILE: ReadonlyArray<readonly [string, string]> = [
      ['a closing quote', "aaaaaaaa-0000-4000-8000-000000000001'"],
      ['a quote and a second array member', "aaaaaaaa-0000-4000-8000-000000000001','evil"],
      ['a comma splice', 'aaaaaaaa-0000-4000-8000-000000000001,evil'],
      ['a closing paren', 'aaaaaaaa-0000-4000-8000-000000000001)'],
      ['an opening paren', 'aaaaaaaa-0000-4000-8000-000000000001('],
      ['a set operation', "aaaaaaaa-0000-4000-8000-000000000001' union all select 1 --"],
      ['a closing bracket', 'aaaaaaaa-0000-4000-8000-000000000001]'],
      ['a bare word', 'evil'],
      ['the empty string', ''],
      ['a one-character string where a uuid belongs', '1'],
    ];
    for (const [label, value] of HOSTILE) {
      const { client, sent } = recordingClient();
      const outcome = await applyNormalizedCoreShaped(client as never, {
        actor: randomUUID(), academy: randomUUID(), command: randomUUID(), round: randomUUID(),
        fingerprintHex: FP_HEX,
        slots: [], targets: [randomUUID()],
        holidayFrom: list(['2026-12-21'], 'date'), holidayTo: list(['2026-12-22'], 'date'),
        holidayLabel: list(['Kerst'], 'text'),
        sources: list([value]), children: list([randomUUID()]),
        targetArray: list([randomUUID()]),
      }).then(() => 'accepted', (e: Error) => e.message);
      expect(outcome, `${label} was rendered instead of refused`).toMatch(/is not a uuid/);
      expect(sent, `${label} reached the server`).toEqual([]);
    }
  });

  it('holds a date and a label to their own shapes, not to the uuid one', async () => {
    // THE VALIDATION IS PER ELEMENT TYPE, so a rule that checked "looks like a uuid" everywhere
    // would accept nothing and one that checked nothing would accept everything. Both directions:
    // the legitimate shapes render, the hostile ones do not.
    const bad: ReadonlyArray<readonly [string, RenderedArray]> = [
      ['a date with a quote', list(["2026-12-21'"], 'date')],
      ['a date that is a statement', list(['2026-12-21; DROP TABLE x'], 'date')],
      ['a label with a quote', list(["Kerst'"], 'text')],
      ['a label with a comma', list(['Kerst,Oud'], 'text')],
      ['a label with a paren', list(['Kerst()'], 'text')],
    ];
    for (const [label, holiday] of bad) {
      const { client, sent } = recordingClient();
      const outcome = await applyNormalizedCoreShaped(client as never, {
        actor: randomUUID(), academy: randomUUID(), command: randomUUID(), round: randomUUID(),
        fingerprintHex: FP_HEX,
        slots: [], targets: [randomUUID()],
        holidayFrom: holiday.type === 'date' ? holiday : list(['2026-12-21'], 'date'),
        holidayTo: list(['2026-12-22'], 'date'),
        holidayLabel: holiday.type === 'text' ? holiday : list(['Kerst'], 'text'),
        sources: list([randomUUID()]), children: list([randomUUID()]),
        targetArray: list([randomUUID()]),
      }).then(() => 'accepted', (e: Error) => e.message);
      expect(outcome, `${label} was rendered instead of refused`)
        .toMatch(/is not a (date|text) this may render/);
      expect(sent, `${label} reached the server`).toEqual([]);
    }
  });

  it('refuses a DISCRIMINANT it does not recognise, which reaches the text like any value',
    async () => {
      // ══ THE FIELD THAT WAS NOT A VALUE UNTIL A REVIEW ROUND MADE IT ONE ══════════════════
      //
      // Every ELEMENT of a rendered array is validated and cannot carry punctuation. `type` was
      // not: it is interpolated straight into the cast (`::${type}[]`), and a caller arriving
      // through `as never` — which is how every fixture that smuggles a value gets here — is held
      // to the union by nothing the compiler did. Supplying an element type of
      // `uuid[] || ARRAY['<foreign>'::uuid]::uuid` with an EMPTY value list validated nothing at
      // all and rendered a second array expression into the statement. Both discriminants are
      // closed sets now, checked at run time.
      const F = '00000000-0000-4000-8000-0000000000ff';
      const hostile: ReadonlyArray<readonly [string, RenderedArray]> = [
        ['an element type that is a second expression',
          { kind: 'literal', type: `uuid[] || ARRAY['${F}'::uuid]::uuid` as never, values: [] }],
        ['an element type that closes the cast', { kind: 'literal', type: 'uuid[]) --' as never,
          values: [] }],
        ['an element type that is not one of the three', { kind: 'literal', type: 'jsonb' as never,
          values: [] }],
        ['a presentation that is not one of the four',
          { kind: 'raw' as never, type: 'uuid', values: [F] }],
      ];
      for (const [label, sources] of hostile) {
        const { client, sent } = recordingClient();
        const outcome = await applyNormalizedCoreShapedExtend(client as never, {
          actor: randomUUID(), academy: randomUUID(), command: randomUUID(), round: randomUUID(),
          fingerprintHex: FP_HEX,
          slots: [], targets: [randomUUID()],
          sources, children: list([randomUUID()]), targetArray: list([randomUUID()]),
        }).then(() => 'accepted', (e: Error) => e.message);
        expect(outcome, `${label} was rendered instead of refused`)
          .toMatch(/not one of the closed array presentations/);
        expect(sent, `${label} reached the server`).toEqual([]);
      }

      // ══ AND EVERY PRESENTATION VALIDATES ITS ELEMENTS, NOT JUST THE LITERAL ONE ════════════
      //
      // The four cases above all use `kind: 'literal'`, so only that arm's `scalar(...)` call was
      // ever driven. The other three arms each call it separately — `with-null` inline, and the
      // two array-INPUT forms through the shared `quoted` helper — and replacing any of those
      // calls with the raw value left every case here green. A value that is not a UUID would
      // then be rendered into the statement instead of refused before anything is sent.
      const notAUuid = "x'::uuid, ARRAY['00000000-0000-4000-8000-0000000000ff'";
      const perPresentation: ReadonlyArray<readonly [string, RenderedArray]> = [
        ['with-null', { kind: 'with-null', type: 'uuid', values: [notAUuid, null] }],
        ['multidim-2x1', { kind: 'multidim-2x1', type: 'uuid', values: [notAUuid, F] }],
        ['zero-based', { kind: 'zero-based', type: 'uuid', values: [notAUuid] }],
        ['literal', { kind: 'literal', type: 'uuid', values: [notAUuid] }],
      ];
      for (const [label, sources] of perPresentation) {
        const { client, sent } = recordingClient();
        const outcome = await applyNormalizedCoreShapedExtend(client as never, {
          actor: randomUUID(), academy: randomUUID(), command: randomUUID(), round: randomUUID(),
          fingerprintHex: FP_HEX,
          slots: [], targets: [randomUUID()],
          sources, children: list([randomUUID()]), targetArray: list([randomUUID()]),
        }).then(() => 'accepted', (e: Error) => e.message);
        expect(outcome, `${label} rendered an element that is not a uuid`)
          .toMatch(/is not a uuid this may render/);
        expect(sent, `${label} reached the server`).toEqual([]);
      }
    });

  it('refuses a date that is a SHAPE but not a calendar day, and renders hex in whole bytes',
    async () => {
      // ══ TWO VALIDATORS THAT PASSED VALUES POSTGRESQL THEN REJECTED ═════════════════════════
      //
      // Both were patterns where a pattern cannot decide the question. `2026-99-99` matched the
      // ISO shape and the refusal came from the server at cast time — after the statement was
      // built and sent, which is the wrong place for it. And `LOWER_HEX` once allowed an ODD
      // number of digits, which then mattered for a `Buffer` subclass whose overridden `toString`
      // could return `'a'`. There is no `Buffer` at this boundary any more: the grammar is applied
      // to the caller's own string, and the odd-length refusal is driven directly above.
      const badDates = ['2026-99-99', '2026-02-30', '2026-13-01', '2026-00-10'];
      for (const day of badDates) {
        const { client, sent } = recordingClient();
        const outcome = await applyNormalizedCoreShaped(client as never, {
          actor: randomUUID(), academy: randomUUID(), command: randomUUID(), round: randomUUID(),
          fingerprintHex: FP_HEX,
          slots: [], targets: [randomUUID()],
          holidayFrom: list([day], 'date'), holidayTo: list(['2026-09-02'], 'date'),
          holidayLabel: list(['Kerst'], 'text'),
          sources: list([randomUUID()]), children: list([randomUUID()]),
          targetArray: list([randomUUID()]),
        }).then(() => 'accepted', (e: Error) => e.message);
        expect(outcome, `${day} is not a day and must not be rendered`)
          .toMatch(/is not a date this may render/);
        expect(sent, `${day} reached the server`).toEqual([]);
      }
      // ...AND A REAL LEAP DAY IS ACCEPTED, so the rule is a calendar and not a narrower pattern.
      const { client, sent } = recordingClient();
      await applyNormalizedCoreShaped(client as never, {
        actor: randomUUID(), academy: randomUUID(), command: randomUUID(), round: randomUUID(),
        fingerprintHex: FP_HEX,
        slots: [], targets: [randomUUID()],
        holidayFrom: list(['2028-02-29'], 'date'), holidayTo: list(['2026-09-02'], 'date'),
        holidayLabel: list(['Kerst'], 'text'),
        sources: list([randomUUID()]), children: list([randomUUID()]),
        targetArray: list([randomUUID()]),
      });
      expect(withoutReadBack(sent).length, 'a real leap day must be accepted').toBe(1);

      // ...AND THE RENDERED HEX IS THE VALIDATED HEX, whole bytes and nothing added. The odd-length
      // REFUSAL is driven in its own test above; this is the positive half: for every accepted
      // length, including zero, the `pg_catalog.decode('<hex>','hex')` the barrier renders carries
      // exactly the string that passed the grammar — two lower-case digits per byte.
      for (const bytes of ['', '61', FP_HEX, '00ff10']) {
        const probe = recordingClient();
        await applyCommandAsActorRenderedBarrier(probe.client as never, {
          academy: randomUUID(), round: randomUUID(), fingerprintHex: bytes,
          slots: [], targets: [randomUUID()],
          sources: list([randomUUID()]), children: list([randomUUID()]),
          targetArray: list([randomUUID()]),
        });
        const rendered = /pg_catalog\.decode\('([0-9a-f]*)','hex'\)/.exec(probe.sent[0].text);
        expect(rendered, `${bytes.length} hex digits must render as a decode() call`)
          .not.toBeNull();
        expect(rendered?.[1], 'the rendered hex must be the validated hex itself')
          .toBe(bytes);
      }
    });

  it('renders each hole from its OWN field, in the declared order, in EVERY template', async () => {
    // ══ EVERY HOLE CALLS THE SAME RENDERER, SO THE FIELD IS NOT AUDITED ═══════════════════════
    //
    // G3 asks that a hole be a direct call of a named private renderer. It cannot ask WHICH FIELD
    // the call reads, and the canonical examples feed the same shape to every hole — so swapping
    // two rendered arrays, or making one hole read another's field, produced a statement that
    // still passed the audit and whose digest simply regenerated from the mutated template.
    //
    // THE EXPECTED ORDER IS PINNED, NOT DERIVED — AND THE FIRST VERSION OF THIS DERIVED IT.
    //
    // Reading the hole order out of the module and then checking the module against it is
    // vacuous: swapping two holes swaps the expectation with them. Measured — the swap this
    // control exists to catch passed. An expectation must not come from the thing it judges, so
    // the order below is a PIN. It moves only when somebody deliberately changes a statement's
    // argument order, which is exactly the edit that should be red.
    // A `Map`, NOT AN OBJECT, because a computed member access — `obj[key]` — is the one shape
    // the sibling-scope rule cannot show is not `.query`, and it refused this file for it.
    const HOLE_ORDER = new Map<string, readonly string[]>([
      ['APPLY_NORMALIZED_CORE_SHAPED', ['holidayFrom', 'holidayTo', 'holidayLabel', 'sources',
        'children', 'targetArray']],
      ['APPLY_NORMALIZED_CORE_SHAPED_EXTEND', ['sources', 'children', 'targetArray']],
      ['APPLY_AS_ACTOR_REFUSAL_PROBE', ['academy']],
      ['APPLY_AS_ACTOR_RENDERED_BARRIER', ['academy', 'round', 'sources', 'children',
        'targetArray', 'fingerprintHex']],
    ]);

    const uuids = Array.from({ length: 8 }, () => randomUUID());
    const dates = ['2026-01-02', '2026-03-04'];
    const labels = ['Alpha', 'Beta'];
    const fingerprintHex = '6669656c646f72646572';
    // One distinct value per field, and the text that value must appear as.
    const field = new Map<string, { value: unknown; needle: string }>([
      ['academy', { value: uuids[0], needle: uuids[0] }],
      ['round', { value: uuids[1], needle: uuids[1] }],
      ['sources', { value: list([uuids[2]]), needle: uuids[2] }],
      ['children', { value: list([uuids[3]]), needle: uuids[3] }],
      ['targetArray', { value: list([uuids[4]]), needle: uuids[4] }],
      ['holidayFrom', { value: list([dates[0]], 'date'), needle: dates[0] }],
      ['holidayTo', { value: list([dates[1]], 'date'), needle: dates[1] }],
      ['holidayLabel', { value: list([labels[0]], 'text'), needle: labels[0] }],
      ['fingerprintHex', { value: fingerprintHex, needle: fingerprintHex }],
    ]);
    const of = (name: string) => {
      const found = field.get(name);
      if (found === undefined) throw new Error(`no distinct value declared for ${name}`);
      return found;
    };
    const base = {
      actor: uuids[5], command: uuids[6], slots: [] as unknown[], targets: [] as string[],
    };
    const drives: ReadonlyArray<readonly [string, string, (c: never) => Promise<unknown>]> = [
      ['applyNormalizedCoreShaped', 'APPLY_NORMALIZED_CORE_SHAPED', (c) =>
        applyNormalizedCoreShaped(c, {
          ...base, academy: of('academy').value as string, round: of('round').value as string,
          fingerprintHex, holidayFrom: of('holidayFrom').value as RenderedArray,
          holidayTo: of('holidayTo').value as RenderedArray,
          holidayLabel: of('holidayLabel').value as RenderedArray,
          sources: of('sources').value as RenderedArray,
          children: of('children').value as RenderedArray,
          targetArray: of('targetArray').value as RenderedArray,
        })],
      ['applyNormalizedCoreShapedExtend', 'APPLY_NORMALIZED_CORE_SHAPED_EXTEND', (c) =>
        applyNormalizedCoreShapedExtend(c, {
          ...base, academy: of('academy').value as string, round: of('round').value as string,
          fingerprintHex, sources: of('sources').value as RenderedArray,
          children: of('children').value as RenderedArray,
          targetArray: of('targetArray').value as RenderedArray,
        })],
      ['applyCommandAsActorRefusalProbe', 'APPLY_AS_ACTOR_REFUSAL_PROBE', (c) =>
        applyCommandAsActorRefusalProbe(c, { academy: of('academy').value as string })],
      ['applyCommandAsActorRenderedBarrier', 'APPLY_AS_ACTOR_RENDERED_BARRIER', (c) =>
        applyCommandAsActorRenderedBarrier(c, {
          academy: of('academy').value as string, round: of('round').value as string,
          fingerprintHex, slots: [], targets: [],
          sources: of('sources').value as RenderedArray,
          children: of('children').value as RenderedArray,
          targetArray: of('targetArray').value as RenderedArray,
        })],
    ];

    for (const [entry, constant, drive] of drives) {
      const holes = HOLE_ORDER.get(constant);
      expect(holes, `${constant} must have a pinned hole order`).toBeTruthy();
      const { client, sent } = recordingClient();
      await drive(client as never);
      const apply = withoutReadBack(sent);
      expect(apply.length, `${entry} must send one statement`).toBe(1);
      const text = apply[0].text;
      // Each hole's OWN value is present…
      const missing = (holes ?? []).filter((f) => !text.includes(of(f).needle));
      expect(missing, `${entry}: every hole must render the field it names`).toEqual([]);
      // …and in the order the template declares, with duplicates collapsed to first appearance.
      const order = [...new Set(holes ?? [])].map((f) => text.indexOf(of(f).needle));
      // `order[i - 1]` would be a COMPUTED member, which the sibling-scope rule cannot show
      // is not `.query` — and it refused this file for exactly that. A pairwise reduce reads
      // the previous element without an index expression at all.
      const ascending = order.reduce<{ ok: boolean; last: number }>(
        (acc, at) => ({ ok: acc.ok && at > acc.last, last: at }), { ok: true, last: -1 },
      ).ok;
      expect(ascending, `${entry}: holes must render in the declared order — got ${order}`)
        .toBe(true);
    }
  });

  it('refuses a scalar UUID hole that is not a canonical UUID', async () => {
    // ══ THE SCALAR RENDERERS HAD NO CASE OF THEIR OWN ══════════════════════════════════════════
    //
    // Every hostile-value case above goes through `renderArray`. The `academy` and `round` holes
    // do not: they are rendered by `uuidLiteral`, and nothing drove them with a value that is not
    // a UUID. Replacing that renderer's body with plain quoting — dropping the validation — left
    // the whole suite and G3 green, because G3 asks only that a hole be a DIRECT CALL of a named
    // private renderer and cannot ask what the renderer does. So the values are driven here.
    const hostile: readonly string[] = [
      // The shape that would end the literal and start an expression.
      "11111111-1111-1111-1111-111111111111','x",
      // ...a comment that would swallow the rest of the line.
      '11111111-1111-1111-1111-111111111111 -- ',
      // ...and two that are merely not canonical, so the rule is a SHAPE and not a quote hunt.
      'not-a-uuid',
      '11111111111111111111111111111111',
    ];
    for (const academy of hostile) {
      const { client, sent } = recordingClient();
      const outcome = await applyCommandAsActorRefusalProbe(client as never, { academy })
        .then(() => 'accepted', (e: Error) => e.message);
      expect(outcome, `${JSON.stringify(academy)} was rendered instead of refused`)
        .toMatch(/is not a uuid this may render/);
      expect(sent, `${JSON.stringify(academy)} reached the server`).toEqual([]);
    }
    // ...AND THE CANONICAL ONES ARE RENDERED, so this is a shape rule and not a ban on the hole.
    // BOTH CASES, because the validator documents either and only `randomUUID()`'s lower case was
    // ever driven — lower-casing the renderer or dropping `A-F` would have stayed green.
    for (const academy of [randomUUID(), randomUUID().toUpperCase(),
      'AB000000-0000-1000-0000-0000000000AA']) {
      const { client, sent } = recordingClient();
      await applyCommandAsActorRefusalProbe(client as never, { academy });
      expect(sent.length, `${academy} did not reach the wire`).toBe(1);
      expect(sent[0].text, `${academy} must reach the statement quoted and unchanged`)
        .toContain(`'${academy}'::uuid`);
    }
  });

  it('renders every value the validator ACCEPTS so it survives array-input syntax', async () => {
    // ══ THE VALUES THAT PASSED VALIDATION AND STILL DID NOT ARRIVE ═════════════════════════════
    //
    // `PLAIN_LABEL` is `/^[A-Za-z ]+$/`, and the two array-INPUT presentations used to write
    // their elements unquoted. Three accepted values were changed or destroyed on the way:
    // `NULL` is four ordinary letters but unquoted it is the SQL null; leading and trailing
    // spaces are stripped; an all-space label renders `{   }`, which is not valid input at all.
    // Nothing drove any of them — every renderer case used UUIDs, which have no such trouble.
    //
    // This asserts the RENDERED TEXT, because that is where the loss happened: the values are
    // quoted, so what the server parses is the label that was handed in.
    const label = (values: readonly string[], kind: 'multidim-2x1' | 'zero-based') =>
      ({ kind, type: 'text', values } as RenderedArray);
    const cases: ReadonlyArray<readonly [string, RenderedArray, string]> = [
      ['a label spelled NULL, in a 2x1', label(['NULL', 'X'], 'multidim-2x1'),
        `'{{"NULL"},{"X"}}'::text[]`],
      ['labels with edge spaces, zero-based', label(['  A', 'B  '], 'zero-based'),
        `'[0:1]={"  A","B  "}'::text[]`],
      ['an all-space label, zero-based', label(['   '], 'zero-based'),
        `'[0:0]={"   "}'::text[]`],
    ];
    for (const [what, holidayLabel, expected] of cases) {
      const { client, sent } = recordingClient();
      await applyNormalizedCoreShaped(client as never, {
        actor: randomUUID(), academy: randomUUID(), command: randomUUID(), round: randomUUID(),
        fingerprintHex: FP_HEX,
        slots: [], targets: [randomUUID()],
        holidayFrom: list(['2026-09-01'], 'date'), holidayTo: list(['2026-09-02'], 'date'),
        holidayLabel,
        sources: list([randomUUID()]), children: list([randomUUID()]),
        targetArray: list([randomUUID()]),
      });
      expect(withoutReadBack(sent).length, `${what} did not reach the wire`).toBe(1);
      expect(sent[0].text, `${what} was not rendered losslessly`).toContain(expected);
    }
  });

  it('refuses an array presentation whose bounds it cannot render', async () => {
    // A zero-based array with no elements has no `[0:N]` bound to write, and a 2x1 that is not
    // two rows is not that presentation. Both are refusals rather than a guessed rendering.
    const shapes: ReadonlyArray<readonly [string, RenderedArray]> = [
      ['a zero-based array with no elements', { kind: 'zero-based', type: 'uuid', values: [] }],
      ['a 2x1 array with one row', { kind: 'multidim-2x1', type: 'uuid', values: [randomUUID()] }],
      ['a 2x1 array with three rows',
        { kind: 'multidim-2x1', type: 'uuid',
          values: [randomUUID(), randomUUID(), randomUUID()] }],
    ];
    for (const [label, sources] of shapes) {
      const { client, sent } = recordingClient();
      const outcome = await applyNormalizedCoreShapedExtend(client as never, {
        actor: randomUUID(), academy: randomUUID(), command: randomUUID(), round: randomUUID(),
        fingerprintHex: FP_HEX,
        slots: [], targets: [randomUUID()],
        sources, children: list([randomUUID()]), targetArray: list([randomUUID()]),
      }).then(() => 'accepted', (e: Error) => e.message);
      expect(outcome, `${label} was rendered instead of refused`)
        .toMatch(/has no bounds|exactly two rows/);
      expect(sent, `${label} reached the server`).toEqual([]);
    }
  });

  it('takes the caller\'s data without calling the caller\'s code', async () => {
    // ══ THREE SEALING RULES, EACH WITH ITS OWN INPUT ═════════════════════════════════════════
    //
    // A review round found each of these unexercised, and two of them by the same argument: the
    // existing hostile input was rejected by an EARLIER rule, so the one under test never ran.
    const fingerprintHex = FP_HEX;
    const base = {
      actor: randomUUID(), academy: randomUUID(), command: randomUUID(), round: randomUUID(),
      fingerprintHex, slots: [] as string[], targets: [randomUUID()],
      sources: list([randomUUID()]), children: list([randomUUID()]),
      targetArray: list([randomUUID()]),
    };

    // (1) AN ARRAY THAT OWNS ITS `map`. Sealing used to call it, so an array could hand back
    //     anything at all — including an object with `toPostgres()`, which the ownership check
    //     skips as a non-string and the driver then serializes. The seal reads `length` and each
    //     index instead, so the element is what is judged.
    const honest = randomUUID();
    const hostileArray: unknown[] = [honest];
    (hostileArray as { map: unknown }).map = () => [{ toPostgres: () => foreignSlot }];
    // THE ENTRYPOINT MATTERS: the shaped ones RENDER their arrays and bind five scalars, so a
    // slot list never reaches the wire there and the control would pass either way. This one
    // binds `slots` as a real parameter, which is where a sealed element is observable.
    const { client: mapClient, sent: mapSent } = recordingClient();
    const viaMap = await applyNormalizedCore(mapClient as never, {
      actor: base.actor, academy: base.academy, version: 'abc27.wire.v1', kind: 'create',
      command: base.command, round: base.round, expected: null, label: 'Seal', start: null,
      end: null, weeks: 2, prio: 7, member: 0, pay: 'deferred_split', strict: false,
      mode: 'inherit', split: false, review: false, price: null, auto: true, lead: null,
      isub: null, ibody: null, rsub: null, rbody: null, rules: null, claim: null,
      hFrom: [], hTo: [], hLabel: [],
      slots: hostileArray as never, children: [randomUUID()], targets: base.targets, fingerprintHex,
    }).then(() => 'accepted', (e: Error) => e.message);
    // THE ARRAY'S OWN `map` IS NEVER CALLED, so what was sealed is the element that is really
    // there — the call is accepted, and the payload that `map` would have produced reaches
    // nothing. Sealing THROUGH `map` would have sent the object instead: the ownership check
    // skips a non-string, and the driver would have asked it what it serializes to.
    expect(viaMap, 'the honest element is the one that arrived').toBe('accepted');
    expect(withoutReadBack(mapSent), 'one apply statement').toHaveLength(1);
    const sentValues = JSON.stringify(mapSent[0].values);
    expect(sentValues.includes(foreignSlot),
      'the payload the array\'s own `map` would have produced reached the wire').toBe(false);
    expect(mapSent[0].values.flatMap((v) => (Array.isArray(v) ? v : [v]))
      .every((v) => v === null || v === undefined || typeof v === 'string'
        || typeof v === 'number' || typeof v === 'boolean' || Buffer.isBuffer(v)),
    'a non-scalar reached the driver, which is what decides its own serialization').toBe(true);

    // (2) A FUNCTION IN A FIELD, not inside an identity list — so the element rule cannot be what
    //     rejects it, and the field rule is the only thing that can.
    const { client: fnClient, sent: fnSent } = recordingClient();
    const viaField = await applyNormalizedCoreShapedExtend(fnClient as never, {
      ...base, fingerprintHex: (() => 'x') as never,
    }).then(() => 'accepted', (e: Error) => e.message);
    expect(viaField, 'a function-valued field decides what it serializes to')
      .toMatch(/is a function/);
    expect(fnSent).toEqual([]);

    // (3) THE BUFFER-WITH-A-LYING-`toString` ARM IS RETIRED, NOT WEAKENED.
    //
    //     It proved that a real `Buffer` whose own `toString` lied could not change the rendered
    //     bytes, because the renderer took the hex from the captured intrinsic instead. There is
    //     no longer a Buffer to lie: this boundary takes canonical hex, and a `Buffer` handed to
    //     it is refused by the primitive test above before any rendering happens. The property it
    //     defended — the rendered bytes are the validated bytes — now holds because the validated
    //     thing IS the rendered thing, with no second reading in between.
  });

  it('renders a bytea value only from validated hex, so injection text never becomes SQL',
    async () => {
      // THE RENDERED BARRIER IS THE ONE PATH WHERE THE FINGERPRINT BECOMES SQL TEXT rather than a
      // bound parameter, so the question "what if the string IS the attack" is sharper here than
      // anywhere else — and it is the question a hex boundary has to answer, because a string is
      // now the accepted type. `pg_catalog.decode('<hex>','hex')` can only ever carry canonical
      // hex: quote, semicolon and space are not hex characters, so the validator refuses before a
      // single character reaches the statement.
      const { client, sent } = recordingClient();
      const outcome = await applyCommandAsActorRenderedBarrier(client as never, {
        academy: randomUUID(), round: randomUUID(),
        fingerprintHex: "abc'::bytea, evil",
        slots: [], targets: [randomUUID()],
        sources: list([randomUUID()]), children: list([randomUUID()]),
        targetArray: list([randomUUID()]),
      }).then(() => 'accepted', (e: Error) => e.message);
      expect(outcome, 'injection text was accepted as canonical hex')
        .toMatch(/is not canonical hex/);
      expect(sent, 'a refused fingerprint reached the wire').toEqual([]);
    });
});

describe('ABC-27 apply catalogue — the STORED row is judged, not only the argument that was sent', () => {
  // ══ THE ARGUMENT-SIDE CHECKS PROVE THE VALUE WAS RIGHT BEFORE IT WAS SENT; THIS PROVES THE
  //    READ-BACK ITSELF DISCRIMINATES ══════════════════════════════════════════════════════════
  //
  // Six of the seven entrypoints now read back what the server actually stored for every target
  // they named, and G3-c makes that call structurally unskippable — but a shape a mutation can
  // discriminate is not the same claim as a runtime control that actually refuses on a bad
  // answer. This drives a HAND-WRITTEN client (the shared stub cannot fabricate a mismatch) that
  // answers the read-back with a row this identity does not own, and proves the entrypoint
  // refuses even though the ARGUMENT it sent was entirely legitimate.
  const collidingReadBack = () => ({
    query: async (_text: string, values: unknown[] = []) => (
      values.length === 1 && Array.isArray(values[0])
        ? { rows: [{ id: foreignSlot, trainer_id: randomUUID() }] }
        : { rows: [{}] }),
  } as never);

  it('refuses when the read-back reports a target id another identity already claimed',
    async () => {
      const outcome = await applyNormalizedCore(collidingReadBack(), {
        ...APPLY_CANONICAL_EXAMPLES.applyNormalizedCore,
        targets: [randomUUID()],
      }).then(() => 'accepted', (e: Error) => e.message);
      expect(outcome, 'a legitimate SEND must still be refused by an illegitimate STORED answer')
        .toMatch(/is owned by/);
    });

  it('the same read-back refusal reaches every entrypoint that verifies one', async () => {
    // THE THREE RENDERED-ARRAY ENTRYPOINTS ALSO CLAIM `targetArray`'s OWN uuids, VIA
    // `noteSlotsOwned`, BEFORE the mock client is ever consulted. Leaving the module's shared
    // canonical `targetArray` unchanged here reaches ids an EARLIER test in this file already
    // claimed under a different identity — `noteSlotsOwned`'s OWN refusal message also contains
    // "is owned by", so the assertion below would have passed for that reason instead of the
    // read-back's. A round found exactly this: fresh ids for every array `noteSlotsOwned` reads,
    // not only the ones a caller happens to name explicitly, is what makes the read-back's own
    // refusal the only one this control can be answering.
    const drives: Record<string, () => Promise<unknown>> = {
      applyNormalizedCore: () => applyNormalizedCore(collidingReadBack(),
        { ...APPLY_CANONICAL_EXAMPLES.applyNormalizedCore, targets: [randomUUID()] }),
      applyCommandAsActorReceiptPrivacy: () => applyCommandAsActorReceiptPrivacy(
        collidingReadBack(),
        { ...APPLY_CANONICAL_EXAMPLES.applyCommandAsActorReceiptPrivacy, targets: [randomUUID()] }),
      applyNormalizedCoreShaped: () => applyNormalizedCoreShaped(collidingReadBack(), {
        ...APPLY_CANONICAL_EXAMPLES.applyNormalizedCoreShaped,
        targets: [randomUUID()], targetArray: list([randomUUID()]),
      }),
      applyNormalizedCoreShapedExtend: () => applyNormalizedCoreShapedExtend(collidingReadBack(), {
        ...APPLY_CANONICAL_EXAMPLES.applyNormalizedCoreShapedExtend,
        targets: [randomUUID()], targetArray: list([randomUUID()]),
      }),
      applyCommandAsActorRenderedBarrier: () => applyCommandAsActorRenderedBarrier(
        collidingReadBack(), {
          ...APPLY_CANONICAL_EXAMPLES.applyCommandAsActorRenderedBarrier,
          targets: [randomUUID()], targetArray: list([randomUUID()]),
        }),
      applyCommandAsActorReachability: () => applyCommandAsActorReachability(collidingReadBack(),
        { ...APPLY_CANONICAL_EXAMPLES.applyCommandAsActorReachability, targets: [randomUUID()] }),
    };
    // THE DRIVE LIST IS EVERY VERIFYING ENTRYPOINT, compared against the pinned inventory minus
    // the one no-slot exception — so an eighth entrypoint, or a ninth verifying one, cannot
    // arrive here unexercised either.
    expect(Object.keys(drives).sort()).toEqual([...APPLY_ENTRYPOINTS]
      .filter((n) => n !== 'applyCommandAsActorRefusalProbe').sort());
    for (const [name, drive] of Object.entries(drives)) {
      const outcome = await drive().then(() => 'accepted', (e: Error) => e.message);
      expect(outcome, `${name} accepted a stored row it does not own`).toMatch(/is owned by/);
    }
  });

  // ══ THE OTHER HALF OF THE SAME FINDING: A REFUSED APPLY MUST NOT EVEN ATTEMPT THE READ-BACK ═
  //
  // The read-back's own SELECT is an ordinary, unprivileged statement — unlike the writing
  // routines, which are SECURITY DEFINER and swallow a malformed `auth.uid()` internally before
  // ever reaching their refusal branch. Driving the real database suite found exactly this gap:
  // a malformed-subject caller's session breaks THIS SELECT's own row-level security, uncaught,
  // turning a uniform closed row into a distinguishing JavaScript exception — precisely the
  // permission oracle the wire protocol's "never zero and never an error" contract exists not to
  // have. The fix is `wasRefused(result)`: skip the read-back when the send's own trusted result
  // already says nothing was written. These drive that skip directly, at the JavaScript layer,
  // independent of any real database — proving the STATEMENT SHAPE the mock stub cannot: no
  // second query is ever attempted after a refused result, for every entrypoint that would
  // otherwise attempt one.
  it('does not attempt the read-back at all when the apply\'s own result reports refused',
    async () => {
      const refusedClient = () => {
        const sent: Array<{ text: string; values: unknown[] }> = [];
        return {
          sent,
          client: {
            query: async (text: string, values: unknown[] = []) => {
              sent.push({ text, values });
              return { rows: [{ status: 'refused', round_id: null }] };
            },
          } as never,
        };
      };
      // EACH ENTRYPOINT'S TARGETS ARE FRESH, not the module's shared canonical examples — those
      // are already claimed by earlier tests in this file, and `noteSlotsOwned` refuses a second
      // claim on the same id regardless of which test is doing the claiming.
      const drives: Record<string, (c: never) => Promise<unknown>> = {
        applyNormalizedCore: (c) => applyNormalizedCore(c,
          { ...APPLY_CANONICAL_EXAMPLES.applyNormalizedCore, targets: [randomUUID()] }),
        applyCommandAsActorReceiptPrivacy: (c) => applyCommandAsActorReceiptPrivacy(c,
          { ...APPLY_CANONICAL_EXAMPLES.applyCommandAsActorReceiptPrivacy, targets: [randomUUID()] }),
        applyNormalizedCoreShaped: (c) => applyNormalizedCoreShaped(c, {
          ...APPLY_CANONICAL_EXAMPLES.applyNormalizedCoreShaped,
          targets: [randomUUID()], targetArray: list([randomUUID()]),
        }),
        applyNormalizedCoreShapedExtend: (c) => applyNormalizedCoreShapedExtend(c, {
          ...APPLY_CANONICAL_EXAMPLES.applyNormalizedCoreShapedExtend,
          targets: [randomUUID()], targetArray: list([randomUUID()]),
        }),
        applyCommandAsActorRenderedBarrier: (c) => applyCommandAsActorRenderedBarrier(c, {
          ...APPLY_CANONICAL_EXAMPLES.applyCommandAsActorRenderedBarrier,
          targets: [randomUUID()], targetArray: list([randomUUID()]),
        }),
        applyCommandAsActorReachability: (c) => applyCommandAsActorReachability(c,
          { ...APPLY_CANONICAL_EXAMPLES.applyCommandAsActorReachability, targets: [randomUUID()] }),
      };
      expect(Object.keys(drives).sort()).toEqual([...APPLY_ENTRYPOINTS]
        .filter((n) => n !== 'applyCommandAsActorRefusalProbe').sort());
      for (const [name, drive] of Object.entries(drives)) {
        const { client, sent } = refusedClient();
        await drive(client as never);
        // EXACTLY ONE STATEMENT — the apply itself. A read-back would be a second one, recognised
        // (as the stub itself recognises it) by shape: a single array-valued parameter.
        expect(sent, `${name} sent something other than just the apply`).toHaveLength(1);
        expect(sent.some((q) => q.values.length === 1 && Array.isArray(q.values[0])),
          `${name} attempted a read-back after a refused apply`).toBe(false);
      }
    });
});
