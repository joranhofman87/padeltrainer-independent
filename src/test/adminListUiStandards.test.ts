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
const LEGACY_OFF_ENGINE_BASELINE = [
  'AcademyEditDialog.tsx',
  'AdminAcademies.tsx',
  'AdminBackups.tsx',        // also a sanctioned escape hatch (expandable rows)
  'AdminGuestPlayers.tsx',
  'AdminPlayerRatings.tsx',  // also a sanctioned escape hatch (inline-edit grid)
  'AdminTrainers.tsx',
  'AdminUsers.tsx',
  'ImportLocationsDialog.tsx',
] as const;
const EXEMPT = new Set<string>([...SANCTIONED_HANDROLLED, ...LEGACY_OFF_ENGINE_BASELINE]);
/**
 * NOTHING is exempt from the density props: every engine table in admin today carries
 * compact + desktopOnly={false} (measured). The set stays for the shrink-only shape, but an
 * empty set means a new offender fails immediately.
 */
const PROPS_EXEMPT = new Set<string>([]);

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

/**
 * The SHARED prop checks — the self-test exercises THESE functions, not a substring lookalike.
 * Whitespace-tolerant: `compact = {false}` and `desktopOnly = {false}` are valid JSX.
 */
type Attr = { name: string; value: string | null };

/**
 * Parse an opening tag's ATTRIBUTES rather than scanning its raw text — a string prop
 * (`empty="use compact desktopOnly={false}"`) otherwise satisfied both checks, and a dynamic
 * `compact={isCompact}` slipped through the bare-prop alternative.
 */
function tagAttributes(usage: string): Attr[] {
  const body = usage.replace(/^<DataTable(<[^>]*>)?/, '').replace(/\/?>$/, '');
  const attrs: Attr[] = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    const nameStart = i;
    while (i < body.length && /[A-Za-z0-9_$]/.test(body[i])) i++;
    const name = body.slice(nameStart, i);
    if (!name) { i++; continue; }
    let j = i;
    while (j < body.length && /\s/.test(body[j])) j++;
    if (body[j] !== '=') { attrs.push({ name, value: null }); continue; }   // bare prop
    j++;
    while (j < body.length && /\s/.test(body[j])) j++;
    if (body[j] === '{') {
      let depth = 1, k = j + 1, quote: string | null = null;
      for (; k < body.length && depth > 0; k++) {
        const ch = body[k];
        if (quote) { if (ch === quote && body[k - 1] !== '\\') quote = null; continue; }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      attrs.push({ name, value: body.slice(j, k) });
      i = k;
    } else if (body[j] === '"' || body[j] === "'") {
      const q = body[j];
      let k = j + 1;
      while (k < body.length && !(body[k] === q && body[k - 1] !== '\\')) k++;
      attrs.push({ name, value: body.slice(j, k + 1) });
      i = k + 1;
    } else {
      const k = body.indexOf(' ', j);
      attrs.push({ name, value: body.slice(j, k === -1 ? undefined : k) });
      i = k === -1 ? body.length : k;
    }
  }
  return attrs;
}

/** compact must be BARE or literally {true} — a dynamic value is not a guarantee. */
const hasCompact = (usage: string): boolean => {
  const a = tagAttributes(usage).find((x) => x.name === 'compact');
  return !!a && (a.value === null || /^\{\s*true\s*\}$/.test(a.value));
};
/** desktopOnly must be literally {false}. */
const hasMobile = (usage: string): boolean => {
  const a = tagAttributes(usage).find((x) => x.name === 'desktopOnly');
  return !!a && /^\{\s*false\s*\}$/.test(a.value ?? '');
};

/** Every <DataTable …> JSX node in a source, as its raw prop text (multiple per file). */
function dataTableUsages(src: string): string[] {
  const out: string[] = [];
  // a JSX opening tag ends at the first `>` that is NOT inside a {…} expression or a string —
  // naive matching stopped at `rows={rows.map((r) => …)}` and mis-read every multi-line usage
  // EXACT component boundary: `<DataTableCard` is a different component and must not match
  const atUsage = (at: number) => at !== -1 && /^[\s<>/]$/.test(src[at + 10] ?? '');
  let i = src.indexOf('<DataTable');
  while (i !== -1 && !atUsage(i)) i = src.indexOf('<DataTable', i + 1);
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
    while (i !== -1 && !atUsage(i)) i = src.indexOf('<DataTable', i + 1);
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
      if (PROPS_EXEMPT.has(name)) continue;   // `return` here exited the whole TEST loop
      dataTableUsages(src).forEach((usage, i) => {
        if (!hasCompact(usage)) offenders.push(`${name}#${i}: missing compact`);
        if (!hasMobile(usage)) offenders.push(`${name}#${i}: missing desktopOnly={false}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  /** Pre-existing table pages that predate ListPageShell adoption. Shrink-only. */
  const LEGACY_NO_SHELL = [
    'AdminBackups.tsx', 'AdminBlog.tsx', 'AdminBlogSources.tsx', 'AdminBlogTopics.tsx',
    'AdminClubs.tsx', 'AdminLocations.tsx', 'AdminOnboardingEmails.tsx', 'AdminPlayerRatings.tsx',
    'AdminPricing.tsx',
  ] as const;

  /** The pre-existing bespoke-shell pages (predate ListPageShell adoption). Shrink-only. */
  const LEGACY_BESPOKE_SHELL = ['AdminCertifications.tsx', 'AdminRatingSystems.tsx'] as const;

  it('every table-rendering admin PAGE uses ListPageShell (bespoke chrome is baselined, not allowed)', () => {
    // a page is a LIST page if it renders a table directly OR composes any extracted section
    // that does — a thin orchestrator must not escape the chrome rule by delegating its tables
    const sectionNames = new Set(
      [...notifSections, ...adminComponents]
        .filter(({ src }) => usesEngine(src) || handRollsTable(src))
        .map(({ name }) => name.replace(/\.tsx$/, '')),
    );
    const composesTableSection = (src: string) =>
      [...sectionNames].some((n) => new RegExp(`\\b${n}\\b`).test(src));
    const offenders = pages
      .filter(({ name, src }) => (rendersTable(src) || composesTableSection(src))
        && !src.includes('ListPageShell')
        && !LEGACY_NO_SHELL.includes(name as never))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
    for (const name of LEGACY_NO_SHELL) {
      const file = pages.find((p) => p.name === name);
      expect(file, `${name} no longer exists — remove it from the baseline`).toBeTruthy();
      expect(file!.src.includes('ListPageShell'), `${name} now uses ListPageShell — remove it from the baseline`).toBe(false);
    }
  });

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
    for (const name of LEGACY_OFF_ENGINE_BASELINE) {
      const file = everything.find((f) => f.name === name);
      expect(file, `${name} is in the baseline but no longer exists — remove it from the list`).toBeTruthy();
      expect(usesEngine(file!.src), `${name} now uses the engine — remove it from the baseline`).toBe(false);
      expect(handRollsTable(file!.src), `${name} no longer hand-rolls a table — remove it from the baseline`).toBe(true);
    }
    expect(PROPS_EXEMPT.size, 'the density baseline is empty and must stay that way').toBe(0);
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
    expect(/(^|\s)compact(\s|\/|>|={true})/.test(usages[1])).toBe(false);

    // the SHARED checkers reject every opt-out spelling (whitespace-tolerant JSX included)
    expect(hasCompact(dataTableUsages(`<DataTable compact={false} desktopOnly={false} />`)[0])).toBe(false);
    expect(hasCompact(dataTableUsages(`<DataTable compact = {false} desktopOnly={false} />`)[0])).toBe(false);
    expect(hasCompact(dataTableUsages(`<DataTable compactish desktopOnly={false} />`)[0])).toBe(false);
    expect(hasCompact(dataTableUsages(`<DataTable compact desktopOnly={false} />`)[0])).toBe(true);
    expect(hasCompact(dataTableUsages(`<DataTable compact={true} desktopOnly={false} />`)[0])).toBe(true);
    expect(hasMobile(dataTableUsages(`<DataTable compact desktopOnly = {false} />`)[0])).toBe(true);
    expect(hasMobile(dataTableUsages(`<DataTable compact desktopOnly={true} />`)[0])).toBe(false);
    expect(hasMobile(dataTableUsages(`<DataTable compact />`)[0])).toBe(false);
    // a DYNAMIC value is not a guarantee, and a STRING prop cannot forge either check
    expect(hasCompact(dataTableUsages(`<DataTable compact={isCompact} desktopOnly={false} />`)[0])).toBe(false);
    expect(hasCompact(dataTableUsages(`<DataTable compact = {isCompact} desktopOnly={false} />`)[0])).toBe(false);
    expect(hasMobile(dataTableUsages(`<DataTable compact desktopOnly={isMobile} />`)[0])).toBe(false);
    const decoy = dataTableUsages(`<DataTable
      columns={columns}
      rows={rows}
      empty="use compact desktopOnly={false}"
    />`)[0];
    expect(hasCompact(decoy)).toBe(false);
    expect(hasMobile(decoy)).toBe(false);
    // …and the real thing still passes, including with a decoy string ALSO present
    const real = dataTableUsages(`<DataTable
      empty="use compact desktopOnly={false}"
      compact
      desktopOnly={false}
    />`)[0];
    expect(hasCompact(real)).toBe(true);
    expect(hasMobile(real)).toBe(true);

    // `<DataTableCard` is a DIFFERENT component and must not be read as an engine usage
    expect(dataTableUsages(`<DataTableCard><Table /></DataTableCard>`)).toEqual([]);

    // multi-line usages with an arrow function in a prop parse correctly (the naive regex
    // stopped at the `=>`'s `>` and reported every real usage as prop-less)
    const multiline = `<DataTable<Row>
      rows={rows.map((r) => ({ ...r, id: r.x }))}
      compact
      desktopOnly={false}
    />`;
    expect(dataTableUsages(multiline)).toHaveLength(1);
    expect(/desktopOnly=\{false\}/.test(dataTableUsages(multiline)[0])).toBe(true);
  });
});
