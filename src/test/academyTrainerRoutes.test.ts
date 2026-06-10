import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');

function readSrc(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

describe('academy trainer route navigation', () => {
  it('registers trainer detail route under /app/academy', () => {
    const router = readSrc('components/DomainRouter.tsx');
    expect(router).toContain('path="trainers/:trainerId"');
    expect(router).toContain('AcademyTrainerDetail');
  });

  it('AcademyTrainers links to unprefixed app trainer detail paths', () => {
    const source = readSrc('pages/academy/AcademyTrainers.tsx');
    expect(source).toContain('navigate(`/app/academy/trainers/${trainer.id}`)');
    expect(source).not.toMatch(/localizePath\(['`]\/app\//);
  });

  it('AcademyTrainerDetail back navigation uses unprefixed trainers list', () => {
    const source = readSrc('pages/academy/AcademyTrainerDetail.tsx');
    expect(source).toContain("navigate('/app/academy/trainers')");
    expect(source).not.toContain('useLocalizedPathFn');
    expect(source).not.toMatch(/localizePath\(['`]\/app\//);
  });

  it('useLocalizedPath skips language prefix for /app routes', () => {
    const source = readSrc('hooks/useLocalizedPath.ts');
    expect(source).toContain('isAppPath');
    expect(source).toMatch(/isAppPath\(normalizedPath\)/);
  });
});
