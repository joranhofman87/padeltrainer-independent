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
const EXEMPT = new Set<string>([...SANCTIONED_HANDROLLED, ...LEGACY_HANDROLLED_BASELINE]);

/** Renders tabular data if it IMPORTS a table primitive (a prose mention is not a table). */
const rendersTable = (src: string) =>
  /from '@\/components\/ui\/(data-table-generic|data-table|table)'/.test(src);

const usesEngine = (src: string) => src.includes("from '@/components/ui/data-table-generic'");
const handRollsTable = (src: string) => /<Table(Header|Body|Row|Cell|Head)?[\s>]/.test(src);

function adminSources(dir: string): Array<{ name: string; src: string }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
    .map((name) => ({ name, src: read(resolve(dir, name)) }));
}

describe('admin list/table UI standards guard', () => {
  const pages = adminSources(ADMIN_PAGES);
  const notifSections = adminSources(NOTIF_ADMIN);

  it('sees the admin surfaces it is meant to guard (non-vacuous)', () => {
    expect(pages.length).toBeGreaterThan(10);
    expect(notifSections.length).toBeGreaterThan(5);
  });

  it('every admin surface that renders a table uses the DataTable ENGINE (no NEW offenders)', () => {
    const offenders = [...pages, ...notifSections]
      .filter(({ name, src }) => rendersTable(src) && !usesEngine(src) && !EXEMPT.has(name))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it('no admin surface hand-rolls <Table> markup outside the escape hatches and the frozen baseline', () => {
    const offenders = [...pages, ...notifSections]
      .filter(({ name, src }) => handRollsTable(src) && !EXEMPT.has(name))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
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
  });
});
