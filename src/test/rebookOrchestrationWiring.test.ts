// @vitest-environment node
// Codex round-11 #3: token co-occurrence pins are false-green capable (moving the scan before the gate,
// or a dead helper call beside a restored unbounded query, would still pass). These are AST-STRUCTURAL
// assertions — they prove the real call GRAPH, not just that a token appears somewhere. Each is
// mutation-verified against the exact bypass Codex named.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

function parse(path: string[], kind: ts.ScriptKind): ts.SourceFile {
  const text = readFileSync(join(process.cwd(), ...path), 'utf8');
  return ts.createSourceFile(path[path.length - 1], text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, kind);
}
const component = (name: string) => parse(['src', 'components', 'cycles', name], ts.ScriptKind.TSX);
const edge = (name: string) => parse(['supabase', 'functions', name, 'index.ts'], ts.ScriptKind.TS);

/** All CallExpressions whose callee is `name(` or `x.name(`. */
function calls(sf: ts.SourceFile, name: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      const callee = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : '';
      if (callee === name) out.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
function within(node: ts.Node, ancestor: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
}
function firstArgString(c: ts.CallExpression): string | null {
  const a = c.arguments[0];
  return a && ts.isStringLiteral(a) ? a.text : null;
}
/** The `scan:` property value node of a gate call's options object, if any. */
function gateScanProp(gate: ts.CallExpression): ts.Node | null {
  const arg = gate.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
  const scan = arg.properties.find((p) => (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name && ts.isIdentifier(p.name) && p.name.text === 'scan');
  return scan ?? null;
}
/** Does a bulk-rebook-cycle invoke pass `body: { …, dryRun: true }` (a preview, not an inline send)?
 *  Requires the LITERAL `true` (Codex round-12 #4): `dryRun: false` (an inline send) must NOT pass. */
function invokeBodyHasDryRunTrue(inv: ts.CallExpression): boolean {
  const arg = inv.arguments[1];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
  const body = arg.properties.find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'body');
  if (!body || !ts.isPropertyAssignment(body) || !ts.isObjectLiteralExpression(body.initializer)) return false;
  return body.initializer.properties.some((p) =>
    ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'dryRun' && p.initializer.kind === ts.SyntaxKind.TrueKeyword);
}

describe('rebook orchestration wiring pins — AST-structural (Codex round-11 #3)', () => {
  it('BOTH wizards create via createAndDrainRebookRound; every direct bulk-rebook-cycle invoke is a dryRun preview', () => {
    for (const wizard of ['RebookCohortWizard.tsx', 'AcademyNewRoundWizard.tsx']) {
      const sf = component(wizard);
      expect(calls(sf, 'createAndDrainRebookRound').length, `${wizard} calls the shared orchestration`).toBeGreaterThan(0);
      // A direct `invoke('bulk-rebook-cycle', …)` in a wizard MUST be a dryRun preview — a non-dryRun
      // one is the inline-send bug. (The helper's own invoke passes fn as a VARIABLE, so it isn't here.)
      const bulkInvokes = calls(sf, 'invoke').filter((c) => firstArgString(c) === 'bulk-rebook-cycle');
      expect(bulkInvokes.length, `${wizard} still has its dryRun preview call(s)`).toBeGreaterThan(0);
      for (const inv of bulkInvokes) {
        expect(invokeBodyHasDryRunTrue(inv), `${wizard}: a direct bulk-rebook-cycle invoke is not dryRun:true ⇒ inline-send bug`).toBe(true);
      }
    }
  });

  it('send-rebook-group-confirmation runs the full member scan INSIDE gateGroupConfirmation.scan (not before the gate)', () => {
    const sf = edge('send-rebook-group-confirmation');
    const gates = calls(sf, 'gateGroupConfirmation');
    expect(gates.length, 'exactly one admission gate').toBe(1);
    const scanProp = gateScanProp(gates[0]);
    expect(scanProp, 'the gate has a `scan` step').not.toBeNull();
    // The member scan (fetchAllKeyset) must live INSIDE the gate's scan step. Moving it before/outside
    // the gate (Codex's mutation) leaves the scan step without a fetchAllKeyset → this fails.
    const keysetInScan = calls(sf, 'fetchAllKeyset').filter((c) => within(c, scanProp!));
    expect(keysetInScan.length, 'the paginated member scan is inside the gate.scan').toBeGreaterThan(0);
  });

  it('all three discovery senders read claims ONLY through fetchAllInChunks (no unbounded slot_id query escapes it)', () => {
    for (const name of ['send-priority-claim-invitation', 'send-rebook-reminder', 'notify-rebook-member-open']) {
      const sf = edge(name);
      const chunks = calls(sf, 'fetchAllInChunks');
      expect(chunks.length, `${name} uses fetchAllInChunks`).toBeGreaterThan(0);
      // EVERY `.in("slot_id", …)` claims read must be inside a fetchAllInChunks call. A restored
      // unbounded query (Codex's mutation) reads slot_id at the top level → not within any chunk → fails,
      // even if a dead fetchAllInChunks call lingers.
      const slotReads = calls(sf, 'in').filter((c) => firstArgString(c) === 'slot_id');
      expect(slotReads.length, `${name} has a slot_id claims read`).toBeGreaterThan(0);
      for (const r of slotReads) {
        expect(chunks.some((ch) => within(r, ch)), `${name}: a slot_id read escapes fetchAllInChunks (unbounded)`).toBe(true);
      }
    }
  });
});
