/* ClientiQ — the customer database, via Supabase.

   Replaces the Sage CRM SData client. ResolveIQ no longer touches Sage CRM or
   the LAN at all:

     read   public.vw_crm_*            company, contacts, activity
     write  public.resolveiq_cases     via resolveiq_upsert_case
     Sage   crm_queue_change           queued by that function, applied on-prem

   Auth is the publishable key plus a signed-in WG account. The service-role key
   is deliberately not supported — it bypasses every permission check, and an
   app that needs it is doing something it should not.

   Everything is keyed on company_id, the Sage CRM company id. account_ref (the
   Sage 200 code) is carried where present but never relied on: only 10.5% of
   companies have one. */

import { config, clientiqConfigured } from './config.mjs';

export class ClientiqError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const REST = (path) => `${config.clientiq.url.replace(/\/+$/, '')}/rest/v1/${path}`;

/* One access token per process, refreshed when it expires. Signing in on every
   request would be slow and would hammer the auth endpoint.
   The token is tagged with the host and account it was issued for — a session
   is only valid for those, so a config change must not silently reuse it. */
let session = { token: null, expiresAt: 0, for: null };

function sessionKey() {
  return `${config.clientiq.url}|${config.clientiq.email}`;
}

async function signIn() {
  if (
    session.token &&
    session.for === sessionKey() &&
    Date.now() < session.expiresAt - 60_000
  ) {
    return session.token;
  }

  const response = await fetch(
    `${config.clientiq.url.replace(/\/+$/, '')}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: { apikey: config.clientiq.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: config.clientiq.email, password: config.clientiq.password })
    }
  );

  const body = await response.text();
  if (!response.ok) {
    throw new ClientiqError(
      `Could not sign in to ClientiQ (${response.status}). Check RESOLVEIQ_SUPABASE_EMAIL and _PASSWORD.`,
      response.status === 400 ? 401 : 502
    );
  }

  const parsed = JSON.parse(body);
  session = {
    token: parsed.access_token,
    expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000,
    for: sessionKey()
  };
  return session.token;
}

async function request(path, { method = 'GET', body, signal } = {}) {
  if (!clientiqConfigured) {
    throw new ClientiqError(
      'ClientiQ is not configured — set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, RESOLVEIQ_SUPABASE_EMAIL and _PASSWORD.',
      503
    );
  }

  const send = async () => {
    const token = await signIn();
    try {
      return await fetch(REST(path), {
        method,
        headers: {
          apikey: config.clientiq.key,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal
      });
    } catch (error) {
      throw new ClientiqError(`Could not reach ClientiQ — ${error.message}`, 503);
    }
  };

  let response = await send();

  /* A cached token can stop being valid before it expires — revoked, rotated,
     or the process outlived the session. Re-authenticate once and retry rather
     than surfacing a 401 the caller can do nothing about. */
  if (response.status === 401) {
    session = { token: null, expiresAt: 0, for: null };
    response = await send();
  }

  const text = await response.text();

  if (!response.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      detail = parsed.message || parsed.hint || detail;
    } catch { /* keep the raw text */ }
    throw new ClientiqError(`ClientiQ ${response.status} — ${detail}`, response.status === 400 ? 400 : 502);
  }

  return text ? JSON.parse(text) : null;
}

/* ---------- reads ---------- */

export async function company(companyId, { signal } = {}) {
  const rows = await request(
    `vw_crm_companies?company_id=eq.${encodeURIComponent(companyId)}&limit=1`,
    { signal }
  );
  return rows?.[0] ?? null;
}

export async function contacts(companyId, { signal } = {}) {
  return (await request(
    `vw_crm_company_contacts?company_id=eq.${encodeURIComponent(companyId)}`,
    { signal }
  )) ?? [];
}

/* Previous contact for the case panel. Newest first, and scheduled items are
   flagged: occurred_at is the completed time where there is one and the booked
   time where there is not, so a task diarised for next March would otherwise
   read as this morning's call. */
export async function activity(companyId, { limit = 8, signal } = {}) {
  const rows = await request(
    `vw_crm_company_activity?company_id=eq.${encodeURIComponent(companyId)}` +
      `&select=comm_id,comm_type,subject,note,occurred_at,logged_by,is_scheduled,source` +
      `&order=occurred_at.desc&limit=${limit}`,
    { signal }
  );
  return (rows ?? []).map((r) => ({
    at: (r.occurred_at || '').slice(0, 10),
    text:
      (r.is_scheduled ? '[scheduled] ' : '') +
      (r.subject || r.comm_type || 'Contact') +
      (r.note ? ` — ${String(r.note).slice(0, 160)}` : ''),
    source: r.source || null
  }));
}

/* Find a company from what a caller gives you. account_ref is sparse, so a
   name search has to work too. */
export async function findCompanies(query, { limit = 10, signal } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const encoded = encodeURIComponent(`*${q}*`);
  return (await request(
    `vw_crm_company_list?or=(name.ilike.${encoded},account_ref.ilike.${encoded})` +
      `&select=company_id,name,account_ref,primary_contact_name&limit=${limit}`,
    { signal }
  )) ?? [];
}

/* ---------- cases ---------- */

export async function openCases({ signal } = {}) {
  return (await request(
    `resolveiq_cases?status=neq.resolved&order=opened_at.asc`,
    { signal }
  )) ?? [];
}

export async function upsertCase({ case: caseFields, event }, { signal } = {}) {
  if (!caseFields?.company_id) {
    throw new ClientiqError(
      'company_id is required — a case with no company cannot reach a customer record',
      400
    );
  }
  if (!caseFields?.subject) throw new ClientiqError('subject is required', 400);

  return request('rpc/resolveiq_upsert_case', {
    method: 'POST',
    body: { payload: { case: caseFields, event: event || null } },
    signal
  });
}

/* Where a queued Sage CRM change has got to: pending -> sending -> sent, or
   dead with a reason after five attempts. */
export async function sageQueueStatus(queueId, { signal } = {}) {
  if (!queueId) return null;
  const rows = await request(
    `vw_crm_outbox?id=eq.${encodeURIComponent(queueId)}&select=status,sage_crm_id,last_error&limit=1`,
    { signal }
  );
  return rows?.[0] ?? null;
}

/* Turn a stored case row into the ticket shape the console renders. */
export function caseToTicket(row, { company, history } = {}) {
  const slaMins = row.sla_minutes ?? config.slaPolicy[row.priority] ?? config.slaPolicy.Default;
  const openedMs = new Date(row.opened_at).getTime();
  const waitMins = row.status === 'resolved' || !Number.isFinite(openedMs)
    ? 0
    : Math.max(0, Math.round((Date.now() - openedMs) / 60000));

  return {
    id: row.case_ref,
    companyId: row.company_id,
    personId: row.person_id ?? null,
    accountRef: row.account_ref ?? null,
    customer: company?.primary_contact_name || 'Unknown contact',
    account: [company?.name, row.account_ref].filter(Boolean).join(' · ') || `Company ${row.company_id}`,
    channel: row.channel || 'Email',
    subject: row.subject,
    intent: row.intent || 'Other',
    sentiment: row.sentiment || 'neutral',
    status: row.status,
    waitMins,
    slaMins,
    assignee: row.owner_email || null,
    priority: row.priority || 'Medium',
    aiConfidence: row.ai_confidence == null ? null : Number(row.ai_confidence),
    aiSuggestion: null,
    aiSummary: row.ai_summary || null,
    escalate: row.ai_escalate ?? null,
    value: 0,
    messages: row.note ? [{ who: company?.primary_contact_name || 'Customer', at: '', text: row.note }] : [],
    history: history || []
  };
}
