// ===========================================================================
// verify-artifacts.mjs — LOCAL executable proof for the 10c-a3 rollout SQL
// artifacts. Boots a real (embedded) Postgres, applies the REAL migration chain
// (base email + on-main digest from the tree, then the three PR #615 migrations
// at a PINNED SHA), then runs each artifact and MUTATION-PROVES that every
// assertion is load-bearing. No Docker, no production, no Supabase project.
//
// Run:  node scripts/rollout/notif-10ca3/verify/verify-artifacts.mjs
// (CI: `npm run verify:rollout`)
// ===========================================================================
import { boot, installPreState, applyPr615, prepared, PR615_SHA } from './chain.mjs';

const PORT = 54357;
let PASS = 0, FAIL = 0;
function record(name, ok, detail = '') {
  if (ok) { PASS++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { FAIL++; console.error(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
}

async function runOk(c, name, sqlName) {
  const notices = [];
  const onNotice = (n) => notices.push(n.message);
  c.on('notice', onNotice);
  try {
    await c.query(prepared(sqlName));
    record(name, true, `${notices.filter((m) => m.startsWith('ok:')).length} assertions passed`);
    for (const m of notices.filter((m) => /A_window|CAP_/.test(m))) console.log(`        · ${m}`);
  } catch (e) {
    record(name, false, `unexpected error: ${e.message}`);
  } finally {
    c.removeListener('notice', onNotice);
  }
}

async function runMutationExpectFail(c, name, mutationSql, sqlName, transform) {
  await c.query('BEGIN');
  try {
    await c.query(mutationSql);
    let text = prepared(sqlName);
    if (transform) text = transform(text);
    let failed = false, msg = '';
    try { await c.query(text); } catch (e) { failed = true; msg = e.message; }
    record(name, failed, failed ? `correctly failed: ${msg.split('\n')[0].slice(0, 120)}` : 'artifact PASSED despite mutation (assertion NOT load-bearing)');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
  }
}

async function main() {
  console.log(`rollout artifact proof — PR615 migrations pinned @ ${PR615_SHA.slice(0, 12)}`);
  const { epg, conn } = await boot(PORT);
  const setup = conn(); await setup.connect();
  try {
    await installPreState(setup);
    console.log('applied base email chain + on-main digest chain (PRE state)');

    // ===== PRE state: preflight PASS (delta absent) + mutation =============
    console.log('\n[PRE] preflight (delta absent):');
    { const c = conn(); await c.connect();
      await runOk(c, 'preflight PASS (un-migrated)', 'preflight.sql');
      await runMutationExpectFail(c, 'preflight mutation: is_suppressed present -> fail',
        `ALTER TABLE public.email_address_state ADD COLUMN is_suppressed boolean;`, 'preflight.sql');
      await c.end();
    }

    await applyPr615(setup);
    console.log('\napplied the three 20261006* PR #615 migrations (POST state)');

    console.log('\n[POST] postflight:');
    { const c = conn(); await c.connect();
      await runOk(c, 'postflight PASS', 'postflight.sql');
      await runMutationExpectFail(c, 'postflight mutation: digest engine enabled -> fail',
        `INSERT INTO public.notification_event_types(key,supports_digest,digest_engine_enabled) VALUES ('x',true,true);`, 'postflight.sql');
      await runMutationExpectFail(c, 'postflight mutation: drop append-only trigger -> fail',
        `DROP TRIGGER trg_orphan_actions_immutable ON public.notification_orphan_reconcile_actions;`, 'postflight.sql');
      await c.end();
    }

    console.log('\n[POST] acl_matrix:');
    { const c = conn(); await c.connect();
      await runOk(c, 'acl_matrix PASS', 'acl_matrix.sql');
      await runMutationExpectFail(c, 'acl mutation: grant anon INSERT on state -> fail',
        `GRANT INSERT ON public.notification_orphan_reconcile_state TO anon;`, 'acl_matrix.sql');
      await runMutationExpectFail(c, 'acl mutation: grant authenticated EXECUTE on internal helper -> fail',
        `GRANT EXECUTE ON FUNCTION public.email_event_rank(text) TO authenticated;`, 'acl_matrix.sql');
      await c.end();
    }

    console.log('\n[POST] ledger_verification:');
    { const c = conn(); await c.connect();
      await runOk(c, 'ledger_verification PASS', 'ledger_verification.sql');
      await runMutationExpectFail(c, 'ledger mutation: out-of-domain state row -> fail',
        `ALTER TABLE public.email_address_state DROP CONSTRAINT email_address_state_state_check;
         INSERT INTO public.email_address_state(email,state) VALUES ('bad@x','bogus');`, 'ledger_verification.sql');
      await c.end();
    }

    console.log('\n[POST] academy_fixture (precedence + rollback):');
    { const c = conn(); await c.connect();
      await runOk(c, 'academy_fixture PASS', 'academy_fixture.sql');
      await c.query('BEGIN');
      try {
        let failed = false, msg = '';
        const noClaim = prepared('academy_fixture.sql')
          .replace(/SELECT set_config\('request\.jwt\.claims'[^;]*;/, 'SELECT 1;')
          .replace(/SELECT set_config\('request\.jwt\.claim\.sub'[^;]*;/, 'SELECT 1;');
        try { await c.query(noClaim); } catch (e) { failed = true; msg = e.message; }
        record('fixture mutation: no manager claim -> 42501 auth failure', failed && /not authorized|42501/.test(msg),
          failed ? `blocked: ${msg.split('\n')[0].slice(0, 90)}` : 'reader ran without manager auth');
      } finally { await c.query('ROLLBACK').catch(() => {}); }
      { const noSeed = prepared('academy_fixture.sql')
          .replace(/\('reg-bounced@example\.test',\s*'hard_bounced',\s*false,\s*'2026-07-01T00:00:00Z'\),/, '');
        let failed = false, msg = '';
        try { await c.query(noSeed); } catch (e) { failed = true; msg = e.message; }
        await c.query('ROLLBACK').catch(() => {});
        record('fixture mutation: drop reg-bounced seed -> case1 fails', failed && /case1|exactly the four/.test(msg),
          failed ? `blocked: ${msg.split('\n')[0].slice(0, 90)}` : 'case1 passed without its suppression row');
      }
      await c.end();
    }

    console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
  } finally {
    await setup.end().catch(() => {});
    await epg.stop().catch(() => {});
  }
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
