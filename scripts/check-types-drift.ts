/**
 * Fail CI when committed Supabase types diverge from local schema after migrations.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TYPES_PATH = 'src/integrations/supabase/types.ts';

const committed = readFileSync(TYPES_PATH, 'utf8');
const tmp = mkdtempSync(join(tmpdir(), 'supabase-types-'));

try {
  execSync(`npx supabase gen types typescript --local > "${join(tmp, 'types.ts')}"`, {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  const generated = readFileSync(join(tmp, 'types.ts'), 'utf8');

  if (committed.trim() !== generated.trim()) {
    writeFileSync(join(tmp, 'types.generated.ts'), generated);
    console.error(
      [
        'Supabase types drift detected.',
        `Committed: ${TYPES_PATH}`,
        'Run: npx supabase gen types typescript --local > src/integrations/supabase/types.ts',
      ].join('\n'),
    );
    process.exit(1);
  }

  console.log('Supabase types match local schema.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
