import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

describe('app shell transition guards', () => {
  it('wraps router with AppBootstrapGate', () => {
    const source = readFileSync(resolve(root, 'App.tsx'), 'utf8');
    expect(source).toContain('AppBootstrapGate');
  });

  it('eager-loads role layouts to keep shell mounted', () => {
    const source = readFileSync(resolve(root, 'components/DomainRouter.tsx'), 'utf8');
    expect(source).toContain("import AcademyLayout from '@/components/academy/AcademyLayout'");
    expect(source).not.toContain('lazy(() => import(\'@/components/academy/AcademyLayout\'))');
  });

  it('academy layout waits for profileReady and suspends outlet only', () => {
    const source = readFileSync(resolve(root, 'components/academy/AcademyLayout.tsx'), 'utf8');
    expect(source).toContain('profileReady');
    expect(source).toContain('authResolving');
    expect(source).toContain('<Suspense fallback={<PageContentSkeleton />}>');
    expect(source).toContain('data-testid="academy-layout-loading"');
  });

  it('player and trainer layouts gate on profileReady with content suspense', () => {
    const player = readFileSync(resolve(root, 'components/player/PlayerLayout.tsx'), 'utf8');
    const trainer = readFileSync(resolve(root, 'components/trainer/TrainerLayout.tsx'), 'utf8');

    expect(player).toContain('profileReady');
    expect(player).toContain('<Suspense fallback={<PageContentSkeleton />}>');
    expect(trainer).toContain('profileReady');
    expect(trainer).toContain('<Suspense fallback={<PageContentSkeleton />}>');
  });

  it('create slot page does not render prerequisite errors while loading', () => {
    const source = readFileSync(resolve(root, 'pages/academy/AcademyCreateSlot.tsx'), 'utf8');
    expect(source).toContain('prerequisitesLoading');
    expect(source).toContain('academy-create-slot-loading');
    expect(source).toContain('AcademyCreateSlotPrerequisites');
  });

  it('academy settings starts mollie status in checking state', () => {
    const source = readFileSync(resolve(root, 'pages/academy/AcademySettings.tsx'), 'utf8');
    expect(source).toMatch(/checkingStatus.*useState\(true\)/s);
  });
});
