#!/usr/bin/env node
/* Connection check for Sage CRM. Run this ON A MACHINE THAT CAN REACH THE CRM
   (WG-SQL-01 or another box on the LAN):

     npm run check-sage

   It reports what the server actually returns — status, format, which entities
   are exposed to web services, and the FIELD NAMES on the case entity.

   It deliberately prints names and counts, never field values, so the output is
   safe to paste back without exporting customer data. */

import { config, sageConfigured } from '../server/config.mjs';
import { SageClient } from '../server/sage.mjs';
import { parseFeed } from '../server/sdata-xml.mjs';

const ok = (s) => `  [ok]   ${s}`;
const bad = (s) => `  [FAIL] ${s}`;
const info = (s) => `         ${s}`;

console.log('\nResolveIQ — Sage CRM connection check');
console.log('='.repeat(52));

if (!sageConfigured) {
  console.log(bad('No Sage CRM configuration found.'));
  console.log(info('Copy .env.example to .env and set SAGE_SERVER and SAGE_USER.'));
  process.exit(1);
}

console.log(`\nTarget: ${config.sage.baseUrl}`);
console.log(`User:   ${config.sage.user}\n`);

const client = new SageClient();
let failures = 0;

/* 1 — can we reach it at all, and what does it speak? */
console.log('1. Reachability and format');
let entitiesBody = null;
try {
  entitiesBody = await client.entities();
  const looksXml = entitiesBody.trimStart().startsWith('<');
  console.log(ok(`connected — server responded to $prototypes`));
  console.log(info(`format: ${looksXml ? 'XML' : 'JSON'}`));
} catch (error) {
  failures++;
  console.log(bad(error.message));
  if (error.status === 401) {
    console.log(info('401 — check the user/password, and that the CRM user has'));
    console.log(info('"Allow Webservices = True" set on their profile.'));
  } else if (error.status === 404) {
    console.log(info('404 — the base URL is probably wrong. Check the install name'));
    console.log(info('and contract segment: {server}/sdata/{install}j/{contract}/-/'));
  } else {
    console.log(info('If this is a network error, confirm you are running this on'));
    console.log(info('the LAN — the CRM is not reachable from outside it.'));
  }
  console.log('\nStopping — nothing else can be checked without a connection.\n');
  process.exit(1);
}

/* 2 — is the case entity exposed? The console is built on cases, so this is
   the make-or-break question. */
console.log('\n2. Entities exposed to web services');
const exposed = [...entitiesBody.matchAll(/<(?:\w+:)?EntityName>([^<]+)</gi)]
  .map((m) => m[1].toLowerCase());
const alsoSeen = [...entitiesBody.matchAll(/"EntityName"\s*:\s*"([^"]+)"/gi)]
  .map((m) => m[1].toLowerCase());
const all = [...new Set([...exposed, ...alsoSeen])].sort();

if (all.length) {
  console.log(info(`${all.length} entities: ${all.join(', ')}`));
  if (all.includes('case')) {
    console.log(ok('"case" is exposed — the queue can read real cases.'));
  } else {
    failures++;
    console.log(bad('"case" is NOT in the exposed list.'));
    console.log(info('The console reads support cases. Either expose the case'));
    console.log(info('entity in Sage CRM admin, or we point the queue at a'));
    console.log(info('different entity (communications, for example).'));
  }
} else {
  console.log(info('Could not parse the entity list — printing the first 400 chars:'));
  console.log(info(entitiesBody.slice(0, 400).replace(/\n/g, ' ')));
}

/* 3 — what fields does a case actually have here? Names only. */
console.log('\n3. Case fields on this install (names only, no values)');
try {
  const raw = await client.request('case', { params: { count: 3 } });
  const { total, records } = client.parse(raw);
  console.log(ok(`read ${records.length} case record(s); server reports ${total} total`));

  if (records.length) {
    const flat = [];
    const linked = [];
    for (const [k, v] of Object.entries(records[0])) {
      if (v && typeof v === 'object') linked.push(`${k}{${Object.keys(v).join(',')}}`);
      else flat.push(k);
    }
    console.log(info(`fields:  ${flat.sort().join(', ')}`));
    if (linked.length) console.log(info(`linked:  ${linked.join(' ')}`));

    /* 4 — does the mapping find what it needs? */
    console.log('\n4. Field mapping');
    const { mapCase } = await import('../server/sage.mjs');
    const ticket = mapCase(records[0]);
    const checks = [
      ['reference', ticket.id, !ticket.id.startsWith('CASE-')],
      ['subject', ticket.subject, ticket.subject !== '(no description)'],
      ['customer', ticket.customer, ticket.customer !== 'Unknown contact'],
      ['status', ticket.status, true],
      ['priority → SLA', `${ticket.priority} → ${ticket.slaMins}m`, ticket.slaMins > 0]
    ];
    for (const [label, value, good] of checks) {
      /* The subject and customer are real data, so show only whether they
         resolved — not what they say. */
      const shown = ['subject', 'customer'].includes(label)
        ? good ? 'resolved' : 'NOT FOUND'
        : value;
      console.log(good ? ok(`${label}: ${shown}`) : bad(`${label}: ${shown}`));
      if (!good) failures++;
    }
    if (failures) {
      console.log(info('\nAnything marked FAIL means this install names that column'));
      console.log(info('differently. Send me the field list from section 3 and I will'));
      console.log(info('add the right names to mapCase() in server/sage.mjs.'));
    }
  } else {
    console.log(info('No case records came back — the entity is readable but empty,'));
    console.log(info('or the API user cannot see any cases.'));
  }
} catch (error) {
  failures++;
  console.log(bad(`reading cases failed — ${error.message}`));
}

console.log('\n' + '='.repeat(52));
console.log(failures ? `${failures} problem(s) found.\n` : 'All checks passed — npm start will serve live cases.\n');
process.exit(failures ? 1 : 0);
