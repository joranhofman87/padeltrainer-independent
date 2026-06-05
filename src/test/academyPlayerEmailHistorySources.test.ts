import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');

function readSrc(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

describe('academy player email history sources', () => {
  it('AcademyPlayerDetail scopes invoices to academy and includes sent_at', () => {
    const source = readSrc('pages/academy/AcademyPlayerDetail.tsx');
    expect(source).toContain("eq('academy_profile_id', activeAcademy!.id)");
    expect(source).toContain('sent_at');
    expect(source).toContain('buildInvoiceEmailEvents');
    expect(source).toContain('mergePlayerEmailHistory');
  });

  it('does not use localizePath for app invoice links in email history', () => {
    const source = readSrc('pages/academy/AcademyPlayerDetail.tsx');
    expect(source).not.toMatch(/localizePath\(['`]\/app\//);
  });

  it('invoice email events link to academy invoice edit page', () => {
    const lib = readSrc('lib/academyPlayerEmailHistory.ts');
    expect(lib).toContain('buildAcademyInvoiceEditPath');
  });
});
