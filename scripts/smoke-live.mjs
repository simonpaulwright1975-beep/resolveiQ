/* Live smoke test against the real ClientiQ (WG Main).
   
   Everything else in this repo is verified against fake servers or by querying
   the database directly. This is the one script that exercises the actual HTTP
   path an advisor's session takes: sign in to GoTrue, read through PostgREST,
   write a case through the RPC, read it back, and delete it again.

   It is deliberately its own script rather than part of `npm test`, because it
   needs credentials and network, writes to the live database, and must never
   run in CI.

   What it does NOT do: resolve a case. Resolving queues a Sage CRM
   communication that an on-prem worker sends within about five minutes, and a
   smoke test must not put a note on a real customer's record.

   Run:  node scripts/smoke-live.mjs
*/

import { config, clientiqConfigured } from '../server/config.mjs';
import * as clientiq from '../server/clientiq.mjs';

/* A company that exists in WG Main. Overridable, because a mirror changes. */
const COMPANY_ID = Number(process.env.SMOKE_COMPANY_ID || 23508);
const MARKER = `smoke-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;

let failures = 0;
let createdCaseId = null;

const pass = (name, detail = '') =>
  console.log(`  ok    ${name}${detail ? ` — ${detail}` : ''}`);
const fail = (name, error) => {
  failures++;
  console.log(`  FAIL  ${name} — ${error.message || error}`);
};

async function step(name, fn) {
  try {
    const detail = await fn();
    pass(name, detail);
    return true;
  } catch (error) {
    fail(name, error);
    return false;
  }
}

async function main() {
  console.log('\nResolveIQ — live smoke test against ClientiQ\n');

  /* A service-role key bypasses every permission check. If one is present the
     test would pass for reasons that tell you nothing about a real session. */
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY || '';
  if (serviceKey || /^sb_secret_/.test(process.env.SUPABASE_PUBLISHABLE_KEY || '')) {
    console.error(
      'REFUSING TO RUN: a service-role key is set. It bypasses RLS, so this\n' +
      'test would prove nothing about what a signed-in advisor can actually do.\n' +
      'Remove it and use the publishable key plus a real WG account.\n'
    );
    process.exit(2);
  }

  if (!clientiqConfigured) {
    console.error(
      'Not configured. Set these in .env:\n' +
      '  SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY,\n' +
      '  RESOLVEIQ_SUPABASE_EMAIL, RESOLVEIQ_SUPABASE_PASSWORD\n'
    );
    process.exit(2);
  }

  console.log(`  host    ${config.clientiq.url}`);
  console.log(`  account ${config.clientiq.email}`);
  console.log(`  company ${COMPANY_ID}\n`);

  /* --- reads: this is also the sign-in test, since the first call authenticates --- */

  const signedIn = await step('sign in and read the company', async () => {
    const row = await clientiq.company(COMPANY_ID);
    if (!row) throw new Error(`company ${COMPANY_ID} not found — set SMOKE_COMPANY_ID`);
    return row.name || `company ${COMPANY_ID}`;
  });

  /* Everything after this needs a working session. Bailing here keeps the
     output honest: one clear failure rather than six identical ones. */
  if (!signedIn) {
    console.log('\nSign-in failed, so the rest cannot run.\n');
    process.exit(1);
  }

  await step('search companies by name', async () => {
    const rows = await clientiq.findCompanies('pelling');
    return `${rows.length} match${rows.length === 1 ? '' : 'es'}`;
  });

  await step('search survives PostgREST syntax characters', async () => {
    /* "Smith, J. & Co." would corrupt an or=() filter if not stripped. */
    await clientiq.findCompanies('Smith, J. & Co. (Holdings)');
    return 'no error';
  });

  await step('read contacts', async () => {
    const rows = await clientiq.contacts(COMPANY_ID);
    return `${rows.length} active`;
  });

  await step('read previous contact', async () => {
    const rows = await clientiq.activity(COMPANY_ID, { limit: 5 });
    return `${rows.length} item${rows.length === 1 ? '' : 's'}`;
  });

  await step('read the open queue', async () => {
    const rows = await clientiq.openCases();
    return `${rows.length} open`;
  });

  /* --- write: the RPC, then read back, then clean up --- */

  await step('raise a case', async () => {
    const result = await clientiq.upsertCase({
      case: {
        company_id: COMPANY_ID,
        subject: 'Live smoke test — safe to delete',
        note: 'Raised by scripts/smoke-live.mjs. Deleted by the same run.',
        intent: 'Other',
        channel: 'Email',
        priority: 'Low',
        status: 'new',
        source: 'resolveiq',
        source_ref: MARKER
      }
    });
    createdCaseId = result?.case?.id ?? null;
    if (!createdCaseId) throw new Error('no case id returned');
    if (result.queued_to_sage) {
      throw new Error('a new case queued a Sage change — it should not until resolved');
    }
    return result.case.case_ref;
  });

  if (createdCaseId) {
    await step('the case appears in the queue', async () => {
      const rows = await clientiq.openCases();
      const found = rows.find((r) => r.id === createdCaseId);
      if (!found) throw new Error('raised case is not in the open queue');
      return found.case_ref;
    });

    await step('the case appears on the customer timeline', async () => {
      const rows = await clientiq.activity(COMPANY_ID, { limit: 20 });
      const found = rows.find((r) => r.source === 'resolveiq');
      if (!found) throw new Error("raised case is not on the company's activity feed");
      return 'source=resolveiq';
    });
  }

  /* --- cleanup: always attempt it, even if assertions above failed --- */

  if (createdCaseId) {
    await step('delete the test case', async () => {
      await clientiq.deleteCase(createdCaseId);
      const rows = await clientiq.openCases();
      if (rows.some((r) => r.id === createdCaseId)) {
        throw new Error('test case is still present — DELETE IT BY HAND');
      }
      return 'removed';
    });
  }

  console.log(
    failures === 0
      ? '\nAll checks passed. ResolveIQ works against live ClientiQ.\n'
      : `\n${failures} check${failures === 1 ? '' : 's'} failed.\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\nUnexpected failure: ${error.stack || error.message}`);
  if (createdCaseId) {
    console.error(
      `\nA test case may remain: ${createdCaseId}\n` +
      'Delete it from resolveiq_cases by hand.\n'
    );
  }
  process.exit(1);
});
