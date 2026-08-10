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
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const [src, out] = process.argv.slice(2);
const PIN_FILE = join(fileURLToPath(new URL('../clone-safety/', import.meta.url)), 'reviewed-migration-chain.json');
if (!src || !out) { console.error('usage: sanitize-migrations.mjs <src_dir> <out_dir>'); process.exit(2); }

// ---------------------------------------------------------------------------
// FAIL CLOSED, two ways.
//
// (a) A REVIEWED DIGEST. `main` moves. A pattern list can only reject the
//     outbound constructs someone already thought of, so the chain itself is
//     pinned: its digest must equal the reviewed value in
//     clone-safety/reviewed-migration-chain.json. Any change — a new migration,
//     an edited one — makes the build refuse until a human re-reviews and
//     re-pins it. That is the only guard that survives an unknown construct.
//
// (b) A PATTERN SWEEP over comment-stripped text, so formatting cannot hide a
//     construct (`CREATE /* x */ EXTENSION` and friends). Extensions are an
//     ALLOW-LIST: anything not explicitly reviewed as inert is refused, rather
//     than a deny-list of the ones we happened to name.
// ---------------------------------------------------------------------------

// Reviewed as having no outbound capability. Everything else is refused.
const ALLOWED_EXT = new Set(['pgcrypto', 'pg_trgm', 'uuid-ossp', 'pgjwt', 'plpgsql', 'citext', 'btree_gist', 'btree_gin']);
// Neutralised rather than refused: the two the rehearsal target must not have.
const NEUTRALISE_EXT = new Set(['pg_cron', 'pg_net']);

const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const CREATE_EXT = /\bCREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z0-9_-]+)"?/gi;

// Top-level calls that reach outside the database, whatever installed them.
const OUTBOUND_CALL = [
  [/\bsupabase_functions\.http_request\b/i, 'invokes supabase_functions.http_request'],
  [/\bextensions\.http_(post|get|delete|put|head)\b/i, 'invokes extensions.http_*'],
  [/\b(?<!net\.)http_(post|get|delete)\s*\(/i, 'invokes a bare http_* function'],
  [/\bdblink(_exec)?\s*\(/i, 'invokes dblink'],
  [/\bCREATE\s+(FOREIGN\s+TABLE|SERVER|USER\s+MAPPING)\b/i, 'creates FDW plumbing'],
  [/\bcron\.schedule_in_database\s*\(/i, 'schedules into another database'],
  [/\bpg_read_(file|binary_file)\s*\(/i, 'reads the server filesystem'],
  [/\bCOPY\b[^;]*\bPROGRAM\b/i, 'runs COPY … PROGRAM'],
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const files = readdirSync(src).filter((f) => f.endsWith('.sql')).sort();
if (!files.length) { console.error(`refusing: no .sql migrations in ${src}`); process.exit(3); }

let neutralised = 0, scanned = 0;
const refusals = [];
const digest = createHash('sha256');
for (const f of files) {
  const raw = readFileSync(join(src, f), 'utf8');
  let text = raw;
  scanned++;
  digest.update(f).update('\0').update(raw).update('\0');

  const live = stripComments(raw);

  // extensions: allow-list, not deny-list
  for (const m of live.matchAll(CREATE_EXT)) {
    const name = m[1].toLowerCase();
    if (NEUTRALISE_EXT.has(name)) continue;                 // handled below
    if (!ALLOWED_EXT.has(name)) refusals.push(`${f}: installs unreviewed extension "${name}"`);
  }
  // neutralise the two, tolerating comments and whitespace between the tokens
  const NEUT = /\bCREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(pg_cron|pg_net)"?[^;]*;/gi;
  const hits = text.match(NEUT);
  if (hits) {
    neutralised += hits.length;
    text = text.replace(NEUT, (mm) =>
      `-- [rehearsal-sanitizer] NEUTRALISED: ${mm.replace(/\s+/g, ' ').trim()}\n` +
      `--   pg_cron/pg_net are never installed on a rehearsal target; sql/platform_stub.sql\n` +
      `--   supplies inert stand-ins so the rest of this migration still applies.\n`);
  }
  // a neutralised statement is a comment by the time we re-check
  const liveAfter = stripComments(text);
  if (/\bCREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(pg_cron|pg_net)"?/i.test(liveAfter)) {
    refusals.push(`${f}: a pg_cron/pg_net CREATE EXTENSION survived neutralisation`);
  }
  for (const [re, why] of OUTBOUND_CALL) {
    if (re.test(liveAfter)) refusals.push(`${f}: ${why}`);
  }
  writeFileSync(join(out, f), text);
}

// (a) the reviewed-chain pin
const chainDigest = digest.digest('hex');
let pinned = null;
try { pinned = JSON.parse(readFileSync(PIN_FILE, 'utf8')); } catch { /* reported below */ }
if (!pinned || typeof pinned.sha256 !== 'string') {
  refusals.push(`missing or unreadable reviewed-chain pin: ${PIN_FILE}`);
} else if (pinned.sha256 !== chainDigest) {
  refusals.push(
    `the migration chain has CHANGED since it was reviewed.\n` +
    `      reviewed: ${pinned.sha256}\n` +
    `      current : ${chainDigest}\n` +
    `      files   : ${scanned} (reviewed ${pinned.files})\n` +
    `      A pattern list only rejects the outbound constructs someone already\n` +
    `      thought of. Re-review the diff, then re-pin with:\n` +
    `        node synth/sanitize-migrations.mjs <src> <out> --write-pin`);
}
// F3: an UNSAFE chain must never be pinnable. The digest mismatch is the only
// refusal --write-pin is allowed to clear; every other refusal (an unreviewed
// extension, an outbound call, a surviving CREATE EXTENSION) blocks pinning, or
// re-pinning would launder exactly what the sweep just found.
const unsafeRefusals = refusals.filter((r) => !r.includes('has CHANGED since it was reviewed')
                                           && !r.includes('reviewed-chain pin'));
if (process.argv.includes('--write-pin')) {
  if (unsafeRefusals.length) {
    console.error('refusing to PIN a chain that is not safe to build from:\n  ' + unsafeRefusals.join('\n  '));
    console.error('\nFix or explicitly neutralise each of these first. Pinning is a record that\nthe chain was reviewed and found inert — it is not a way to silence the sweep.');
    process.exit(5);
  }
  // PRESERVE the human review history. `reviews[]` is where a reviewer records WHAT they read in
  // the diff and why the sanitized clone is still inert — the reasoning the next person to hit this
  // guard needs. The sanitizer itself reads only sha256/files, so the array is documentation rather
  // than authorization; rewriting the object wholesale would silently delete it on the very command
  // a reviewer runs at the end of doing the review.
  let previous = {};
  try { previous = JSON.parse(readFileSync(PIN_FILE, 'utf8')); } catch { /* first pin */ }
  writeFileSync(PIN_FILE, JSON.stringify({
    _comment: 'Digest of the migration chain reviewed for outbound behaviour. Re-pin only after reviewing the diff.',
    sha256: chainDigest, files: scanned, pinned_at: new Date().toISOString().slice(0, 10),
    ...(previous.reviews ? { reviews: previous.reviews } : {}),
  }, null, 2) + '\n');
  console.log(`PINNED sha256=${chainDigest} files=${scanned}`);
  process.exit(0);
}

if (refusals.length) {
  console.error('refusing to build a rehearsal target from this chain:\n  ' + refusals.join('\n  '));
  console.error('\nEach of these could give the target a way out of the box. Neutralise it\nexplicitly (and review it) rather than letting the build guess.');
  process.exit(4);
}
console.log(`SANITIZED files=${scanned} neutralised_extension_statements=${neutralised} chain_sha256=${chainDigest.slice(0, 16)} out=${out}`);
