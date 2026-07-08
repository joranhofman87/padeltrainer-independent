import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ACADEMY_PAGE_SOURCES = [
  'src/pages/academy/AcademyPlayers.tsx',
  'src/pages/academy/AcademyCalendar.tsx',
  'src/pages/academy/AcademyDashboard.tsx',
  'src/components/academy/SlotDetailDialog.tsx',
];

/** Strip comments so documentation strings do not false-positive. */
function codeWithoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const INVALID_TRAINER_PROFILE_EMBED = /profiles:user_id\s*\(/;
const INVALID_SLOT_TRAINER_EMBED = /slot_trainer:trainer_profiles/;

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

describe('academy PostgREST embed safety', () => {
  it.each(ACADEMY_PAGE_SOURCES)('%s does not embed profiles:user_id on trainer_profiles', (file) => {
    const code = codeWithoutComments(readSource(file));
    expect(code).not.toMatch(INVALID_TRAINER_PROFILE_EMBED);
    expect(code).not.toMatch(INVALID_SLOT_TRAINER_EMBED);
  });
});
