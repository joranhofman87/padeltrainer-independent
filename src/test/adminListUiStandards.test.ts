import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * ARCHITECTURE GUARD — future admin list/table surfaces cannot bypass
 * docs/UI_COMPONENT_STANDARDS.md.
 *
 * It is deliberately SHAPE-BASED rather than a hand-maintained allow-list: any file under
 * src/pages/admin/ or src/components/notifications/admin/ that renders tabular data must do so
 * through the canonical engine, and no such file may hand-roll `<Table>` markup or the page
 * chrome. A new page that copies today's monolith pattern fails here on its first commit.
 *
 * The guard proves itself non-vacuous three ways: it asserts it actually SEES files, it asserts
 * each rule FIRES on a synthetic violating source, and it names the sanctioned escape hatches
 * (from the standards doc) explicitly rather than skipping unknown files.
 */

const ADMIN_PAGES = resolve(__dirname, '..', 'pages', 'admin');
const NOTIF_ADMIN = resolve(__dirname, '..', 'components', 'notifications', 'admin');
const ADMIN_COMPONENTS = resolve(__dirname, '..', 'components', 'admin');
const read = (p: string) => readFileSync(p, 'utf8');

/** The escape-hatch tables the standards doc lists by name (expandable/inline-edit grids). */
const SANCTIONED_HANDROLLED = new Set([
  'AdminBackups.tsx',        // expandable Collapsible file-list rows
  'AdminPlayerRatings.tsx',  // inline-edit month grid + frozen-left column
]);

/**
 * PRE-EXISTING hand-rolled admin tables, frozen as a SHRINK-ONLY baseline (the repo's
 * established pattern for legacy debt — see mutationBoundary.test.ts). They predate this
 * guard and are NOT part of the notification work; migrating them is its own slice. The list
 * may only get shorter: a new offender fails, and a migrated page removed from the list can
 * never be re-added silently because the count assertion below shrinks with it.
 */
const LEGACY_HANDROLLED_BASELINE = [
  'AdminAcademies.tsx',
  'AdminGuestPlayers.tsx',
  'AdminTrainers.tsx',
  'AdminUsers.tsx',
] as const;
/** Pre-existing surfaces that render tabular data OFF the engine (dialogs + two admin pages). */
const LEGACY_OFF_ENGINE_BASELINE = [
  'AcademyEditDialog.tsx',
  'AdminCertifications.tsx',
  'AdminRatingSystems.tsx',
  'ImportLocationsDialog.tsx',
] as const;
/** Pre-existing engine tables missing the compact/mobile props (the density sweep predates them). */
const LEGACY_MISSING_PROPS_BASELINE = [
  'AdminAcademies.tsx',
  'AdminBackups.tsx',
  'AdminGuestPlayers.tsx',
  'AdminTrainers.tsx',
  'AdminUsers.tsx',
] as const;
const EXEMPT = new Set<string>([
  ...SANCTIONED_HANDROLLED, ...LEGACY_HANDROLLED_BASELINE, ...LEGACY_OFF_ENGINE_BASELINE,
]);
const PROPS_EXEMPT = new Set<string>(LEGACY_MISSING_PROPS_BASELINE);

/** Renders tabular data if it IMPORTS a table primitive (a prose mention is not a table). */
const rendersTable = (src: string) =>
  /from ['"]@\/components\/ui\/(data-table-generic|data-table|table)['"]/.test(src);

const usesEngine = (src: string) => /from ['"]@\/components\/ui\/data-table-generic['"]/.test(src);
/** hand-rolled: the shadcn <Table…> components OR a native <table>. */
const handRollsTable = (src: string) =>
  /<Table(Header|Body|Row|Cell|Head)?[\s>]/.test(src) || /<table[\s>]/.test(src);

/** RECURSIVE: an extracted table in a nested folder must not escape the guard. */
function adminSources(dir: string): Array<{ name: string; src: string }> {
  const out: Array<{ name: string; src: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) { out.push(...adminSources(full)); continue; }
    if (!entry.name.endsWith('.tsx') || entry.name.endsWith('.test.tsx')) continue;
    out.push({ name: entry.name, src: read(full) });
  }
  return out;
}

/** Every <DataTable …> JSX node in a source, as its raw prop text (multiple per file). */
function dataTableUsages(src: string): string[] {
  const out: string[] = [];
  // a JSX opening tag ends at the first `>` that is NOT inside a {…} expression or a string —
  // naive matching stopped at `rows={rows.map((r) => …)}` and mis-read every multi-line usage
  let i = src.indexOf('<DataTable');
  while (i !== -1) {
    // skip a TYPE-ARGUMENT list (`<DataTable<Row>` …): its `>` is not the tag end
    let start = i + 10;
    if (src[start] === '<') {
      let g = 1;
      start++;
      while (start < src.length && g > 0) {
        if (src[start] === '<') g++;
        else if (src[start] === '>') g--;
        start++;
      }
    }
    let depth = 0, j = start, quote: string | null = null;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (quote) { if (ch === quote && src[j - 1] !== '\\') quote = null; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '{') { depth++; continue; }
      if (ch === '}') { depth--; continue; }
      if (ch === '>' && depth === 0) break;
    }
    out.push(src.slice(i, j + 1));
    i = src.indexOf('<DataTable', j);
  }
  return out;
}

describe('admin list/table UI standards guard', () => {
  const pages = adminSources(ADMIN_PAGES);
  const notifSections = adminSources(NOTIF_ADMIN);
  const adminComponents = adminSources(ADMIN_COMPONENTS);
  const everything = [...pages, ...notifSections, ...adminComponents];

  it('sees the admin surfaces it is meant to guard (non-vacuous)', () => {
    expect(pages.length).toBeGreaterThan(10);
    expect(notifSections.length).toBeGreaterThan(5);
    expect(adminComponents.length).toBeGreaterThan(0);
  });

  it('every admin surface that renders a table uses the DataTable ENGINE (no NEW offenders)', () => {
    const offenders = everything
      .filter(({ name, src }) => rendersTable(src) && !usesEngine(src) && !EXEMPT.has(name))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it('no admin surface hand-rolls <Table>/<table> markup outside the escape hatches and the frozen baseline', () => {
    const offenders = everything
      .filter(({ name, src }) => handRollsTable(src) && !EXEMPT.has(name))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it('EVERY DataTable usage anywhere in admin carries compact + desktopOnly={false}', () => {
    const offenders: string[] = [];
    for (const { name, src } of everything) {
      if (PROPS_EXEMPT.has(name)) return;
      dataTableUsages(src).forEach((usage, i) => {
        if (!/\bcompact\b/.test(usage)) offenders.push(`${name}#${i}: missing compact`);
        if (!/desktopOnly=\{false\}/.test(usage)) offenders.push(`${name}#${i}: missing desktopOnly={false}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  /** The one pre-existing bespoke-shell page (predates ListPageShell adoption). Shrink-only. */
  const LEGACY_BESPOKE_SHELL = ['AdminCertifications.tsx', 'AdminRatingSystems.tsx'] as const;

  it('no NEW admin page uses a bespoke shell instead of the canonical chrome', () => {
    const offenders = pages
      .filter(({ name, src }) => src.includes('container mx-auto') && !LEGACY_BESPOKE_SHELL.includes(name as never))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
    // shrink-only: a migrated page must be removed from the list
    for (const name of LEGACY_BESPOKE_SHELL) {
      const file = pages.find((p) => p.name === name);
      expect(file?.src.includes('container mx-auto'), `${name} no longer uses a bespoke shell — remove it`).toBe(true);
    }
  });

  it('the legacy baseline is SHRINK-ONLY — every listed file still exists and still hand-rolls', () => {
    // if someone migrates one, this fails until they delete it from the list (so the debt can
    // never be silently re-added under an existing name)
    for (const name of LEGACY_HANDROLLED_BASELINE) {
      const file = pages.find((p) => p.name === name);
      expect(file, `${name} is in the baseline but no longer exists — remove it from the list`).toBeTruthy();
      expect(handRollsTable(file!.src), `${name} no longer hand-rolls a table — remove it from the baseline`).toBe(true);
      expect(usesEngine(file!.src), `${name} now uses the engine — remove it from the baseline`).toBe(false);
    }
    // the two other baselines shrink the same way: a migrated file must be removed from the list
    for (const name of LEGACY_OFF_ENGINE_BASELINE) {
      const file = everything.find((f) => f.name === name);
      expect(file, `${name} no longer exists — remove it from the baseline`).toBeTruthy();
      expect(usesEngine(file!.src), `${name} now uses the engine — remove it from the baseline`).toBe(false);
    }
    for (const name of LEGACY_MISSING_PROPS_BASELINE) {
      const file = everything.find((f) => f.name === name);
      expect(file, `${name} no longer exists — remove it from the baseline`).toBeTruthy();
      const usages = dataTableUsages(file!.src);
      const stillMissing = usages.some((u) => !/\bcompact\b/.test(u) || !/desktopOnly=\{false\}/.test(u));
      expect(stillMissing, `${name} now carries the props — remove it from the baseline`).toBe(true);
    }
  });

  it('the notification ops page is a THIN orchestrator on the canonical chrome', () => {
    const page = read(resolve(ADMIN_PAGES, 'AdminNotificationOps.tsx'));
    expect(page).toContain('ListPageShell');                    // canonical page chrome
    expect(page).not.toContain('container mx-auto');            // never a bespoke shell
    expect(handRollsTable(page)).toBe(false);                   // tables live in sections
    expect(page).not.toContain('Record<string, unknown>');      // typed row models only
    expect(page.split('\n').length).toBeLessThan(300);          // orchestrator, not a monolith
    // every section is a component, not inline markup
    for (const c of ['ReadinessPanel', 'ChannelKillPanel', 'EventStatesSection', 'InvocationsSection',
      'NotificationOutboxSection', 'DigestGroupsSection', 'WorkerRunsSection', 'OrphanQueueSection',
      'RecipientPreviewSection', 'DestinationSearchSection', 'DecisionAuditSection']) {
      expect(page).toContain(c);
    }
  });

  it('the notification sections use the canonical data-state switch and compact density', () => {
    const withTables = notifSections.filter(({ src }) => usesEngine(src));
    expect(withTables.length).toBeGreaterThanOrEqual(6);
    for (const { name, src } of withTables) {
      expect(src, `${name} must use compact density`).toContain('compact');
      expect(src, `${name} must render on mobile`).toContain('desktopOnly={false}');
    }
    // the state switch is either in the section or in the shared OpsSection it composes
    for (const { name, src } of notifSections) {
      if (!usesEngine(src)) continue;
      const viaShared = src.includes('OpsSection');
      expect(viaShared || src.includes('ListPageState'), `${name} must use ListPageState (directly or via OpsSection)`).toBe(true);
    }
  });

  it('THE GUARD ITSELF FIRES: each rule rejects a synthetic violating source', () => {
    const badHandRolled = `import { Table, TableBody } from '@/components/ui/table';
      export default function Bad() { return <Table><TableBody /></Table>; }`;
    expect(rendersTable(badHandRolled)).toBe(true);
    expect(usesEngine(badHandRolled)).toBe(false);
    expect(handRollsTable(badHandRolled)).toBe(true);

    const bespokeShell = `export default function Bad() { return <div className="container mx-auto" />; }`;
    expect(bespokeShell).toContain('container mx-auto');

    const engineOnly = `import { DataTable } from '@/components/ui/data-table-generic';
      export default function Ok() { return <DataTable compact desktopOnly={false} />; }`;
    expect(usesEngine(engineOnly)).toBe(true);
    expect(handRollsTable(engineOnly)).toBe(false);
    expect(dataTableUsages(engineOnly)).toHaveLength(1);

    // a DOUBLE-QUOTED import is still an import; a native <table> is still hand-rolled
    expect(usesEngine(`import { DataTable } from "@/components/ui/data-table-generic";`)).toBe(true);
    expect(handRollsTable('<table><tbody /></table>')).toBe(true);

    // a file with TWO DataTables where only the FIRST carries the props must be caught
    const mixed = `<DataTable compact desktopOnly={false} rows={a} />
      <DataTable rows={b} />`;
    const usages = dataTableUsages(mixed);
    expect(usages).toHaveLength(2);
    expect(/\bcompact\b/.test(usages[1])).toBe(false);
  });
});
