/* The central customer record (Supabase / Postgres).

   Writes go through one database function, public.resolveiq_upsert_case, rather
   than straight at the tables:

     - the `core` schema is not in Supabase's exposed-schemas list, so
       /rest/v1/cases would 404; /rest/v1/rpc/ works without changing project
       settings;
     - validation and the lifecycle timestamps live in one place instead of
       being re-implemented by every producer;
     - it is idempotent on case_ref, so a retry after a timeout is safe.

   The service key bypasses row level security and must never reach a browser.
   It is read here and used only here. */

import { config, storeConfigured } from './config.mjs';

export class StoreError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/* Shape a ticket as the console holds it into the case the database expects.
   Exported for testing — the mapping is the part worth getting wrong. */
export function ticketToCase(ticket, { agent, resolution } = {}) {
  return {
    case_ref: ticket.id,
    account_ref: ticket.accountRef || null,
    subject: ticket.subject,
    detail: ticket.messages?.[0]?.text || null,
    category: ticket.intent || null,
    channel: ticket.channel || null,
    intent: ticket.intent || null,
    sentiment: ticket.sentiment || null,
    priority: ticket.priority || 'Medium',
    status: ticket.status,
    owner_email: ticket.assignee || agent || null,
    resolution: resolution || null,
    next_action: Array.isArray(ticket.nextSteps) ? ticket.nextSteps.join('; ') : null,
    ai_summary: ticket.aiSummary || null,
    ai_confidence: typeof ticket.aiConfidence === 'number' ? ticket.aiConfidence : null,
    ai_escalate: typeof ticket.escalate === 'boolean' ? ticket.escalate : null,
    source: 'resolveiq'
  };
}

export async function upsertCase({ case: caseFields, event }, { signal } = {}) {
  if (!storeConfigured) {
    throw new StoreError(
      'The customer record is not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY.',
      503
    );
  }

  if (!caseFields?.case_ref) throw new StoreError('case_ref is required', 400);
  if (!caseFields?.subject) throw new StoreError('subject is required', 400);

  const url = `${config.store.url.replace(/\/+$/, '')}/rest/v1/rpc/resolveiq_upsert_case`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: config.store.serviceKey,
        Authorization: `Bearer ${config.store.serviceKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ payload: { case: caseFields, event: event || null } }),
      signal
    });
  } catch (error) {
    /* A network failure here must not look like a successful save. */
    throw new StoreError(`Could not reach the customer record — ${error.message}`, 503);
  }

  const body = await response.text();

  if (!response.ok) {
    let detail = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body);
      detail = parsed.message || parsed.hint || detail;
    } catch { /* keep the raw text */ }
    throw new StoreError(
      `Customer record rejected the case (${response.status}) — ${detail}`,
      response.status === 400 ? 400 : 502
    );
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new StoreError('Customer record returned a response that was not JSON', 502);
  }
}
