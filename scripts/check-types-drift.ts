/**
 * Fail CI when committed Supabase types diverge from local schema after migrations.
 *
 * Prefers the `supabase` binary on PATH (in CI that's the supabase/setup-cli Go
 * binary, which generates local types without platform auth). Falls back to
 * `npx supabase` for local dev. The npm-distributed CLI (>= 2.106) wrongly
 * demands an access token even for `gen types --local`
 * (LegacyPlatformAuthRequiredError), which is why the PATH binary comes first.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TYPES_PATH = 'src/integrations/supabase/types.ts';

function resolveSupabaseBin(): string {
  try {
    execSync('supabase --version', { stdio: 'ignore' });
    return 'supabase';
  } catch {
    return 'npx supabase';
  }
}

const committed = readFileSync(TYPES_PATH, 'utf8');
const tmp = mkdtempSync(join(tmpdir(), 'supabase-types-'));
const supabaseBin = resolveSupabaseBin();

try {
  execSync(`${supabaseBin} gen types typescript --local > "${join(tmp, 'types.ts')}"`, {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  const generated = readFileSync(join(tmp, 'types.ts'), 'utf8');

  if (committed.trim() !== generated.trim()) {
    // Persist the generated file where CI can pick it up as an artifact, so
    // the fix is one download away instead of needing a local stack.
    writeFileSync('types.generated.ts', generated);
    const committedLines = committed.trim().split('\n');
    const generatedLines = generated.trim().split('\n');
    const firstDiff = committedLines.findIndex((l, i) => l !== generatedLines[i]);
    console.error(
      [
        'Supabase types drift detected.',
        `Committed: ${TYPES_PATH} (${committedLines.length} lines)`,
        `Generated: types.generated.ts (${generatedLines.length} lines)`,
        `First differing line: ${firstDiff + 1}`,
        `  committed: ${committedLines[firstDiff] ?? '<eof>'}`,
        `  generated: ${generatedLines[firstDiff] ?? '<eof>'}`,
        'Run: npx supabase gen types typescript --local > src/integrations/supabase/types.ts',
      ].join('\n'),
    );
    process.exit(1);
  }

  console.log('Supabase types match local schema.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
