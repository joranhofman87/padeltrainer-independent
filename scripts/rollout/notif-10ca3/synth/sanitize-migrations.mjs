// ===========================================================================
// sanitize-migrations.mjs — produce a migration source that CANNOT schedule or
// send, then let `supabase db push` replay it normally.
//
// The previous approach pre-created a `cron` schema and hoped migrations would
// land in it. That cannot work: the chain runs CREATE EXTENSION pg_cron and
// pg_net (20260117134212, 20260330204208), which create those very objects and
// collide with the stand-ins — and once the real extensions are installed there
// is a real scheduler and a real network primitive on the target again.
//
// So the extensions are never installed. Their CREATE EXTENSION statements are
// neutralised here, sql/platform_stub.sql supplies inert `cron`/`net` objects
// beforehand, and every cron.schedule / net.http_post call in the chain then
// resolves to something that records intent and does nothing.
//
// FAIL CLOSED: anything that looks like it could schedule or send but does not
// match a known-neutralisable form aborts the build. A rehearsal target is not
// worth guessing about.
//
// usage: sanitize-migrations.mjs <src_dir> <out_dir>
// ===========================================================================
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error('usage: sanitize-migrations.mjs <src_dir> <out_dir>'); process.exit(2); }

// Extensions that must NEVER exist on a rehearsal target: they are the two
// capabilities the whole exercise is about not having.
const FORBIDDEN_EXT = /\bCREATE\s+EXTENSION\s+(IF\s+NOT\s+EXISTS\s+)?"?(pg_cron|pg_net)"?[^;]*;/gi;
// Anything else that could reach outside the database.
const SUSPECT = [
  [/\bCREATE\s+EXTENSION\s+(IF\s+NOT\s+EXISTS\s+)?"?(dblink|postgres_fdw|http|wrappers)"?/i, 'installs an outbound extension'],
  [/\bCREATE\s+SERVER\b/i, 'creates a foreign server'],
  [/\bcron\.schedule_in_database\s*\(/i, 'schedules into another database'],
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const files = readdirSync(src).filter((f) => f.endsWith('.sql')).sort();
if (!files.length) { console.error(`refusing: no .sql migrations in ${src}`); process.exit(3); }

let neutralised = 0, scanned = 0;
const refusals = [];
for (const f of files) {
  let text = readFileSync(join(src, f), 'utf8');
  scanned++;
  const hits = text.match(FORBIDDEN_EXT);
  if (hits) {
    neutralised += hits.length;
    text = text.replace(FORBIDDEN_EXT, (m) =>
      `-- [rehearsal-sanitizer] NEUTRALISED: ${m.replace(/\s+/g, ' ').trim()}\n` +
      `--   pg_cron/pg_net are never installed on a rehearsal target; sql/platform_stub.sql\n` +
      `--   supplies inert stand-ins so the rest of this migration still applies.\n`);
  }
  for (const [re, why] of SUSPECT) {
    // a neutralised line is a comment by now, so only live text can match
    const live = text.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
    if (re.test(live)) refusals.push(`${f}: ${why}`);
  }
  writeFileSync(join(out, f), text);
}

if (refusals.length) {
  console.error('refusing to build a rehearsal target from this chain:\n  ' + refusals.join('\n  '));
  console.error('\nEach of these could give the target a way out of the box. Neutralise it\nexplicitly (and review it) rather than letting the build guess.');
  process.exit(4);
}
console.log(`SANITIZED files=${scanned} neutralised_extension_statements=${neutralised} out=${out}`);
