/* Sage CRM SData client.

   Verified against Sage's own reference client
   (github.com/Sage/sage_crm_rest_api_client):

     base URL   {http|https}://{server}/sdata/{install}j/{contract}/-/
                e.g. http://WG-SQL-01/sdata/crmj/sagecrm/-/   (Geerings install)
                The contract segment differs between installs — "sagecrm" and
                "sagecrm2" both exist in the wild — so it is configurable.
     format     Atom XML. The Geerings install errors on Accept: application/json,
                so reads ask for application/atom+xml and are parsed by
                sdata-xml.mjs into the same record shape a JSON reply would give.
     auth       HTTP Basic, user:password
     collection GET {base}{entity}
                -> { $totalResults, $startIndex, $itemsPerPage, $resources: [...] }
     record     GET {base}{entity}('{id}')
                -> { $key, $title, $url, ...fields }
     metadata   GET {base}$prototypes           (all entities)
                GET {base}$prototypes/{entity}  (fields on one entity)

   Field names vary between installs (custom fields, renamed columns), so every
   read goes through pick(), which tries a list of candidate names rather than
   assuming one. Anything it can't find degrades to a sensible default instead
   of throwing — a missing column should not take the queue offline. */

import { config } from './config.mjs';
import { parseFeed } from './sdata-xml.mjs';

const CHANNEL_HINTS = [
  [/phone|call|voice|telephone/i, 'Voice'],
  [/email|e-mail|mail/i, 'Email'],
  [/chat|web|portal|online/i, 'Chat']
];

/* Keyword sentiment. Deliberately crude — it only sets the initial dot colour.
   /api/suggest returns a model-assessed sentiment that replaces it. */
const SENTIMENT_RULES = [
  [/furious|appalling|disgrace|unacceptable|solicitor|legal action|cancel my account|worst/i, 'angry'],
  [/still waiting|again|chased|no response|frustrat|annoy|third time|second time|fed up/i, 'frustrated'],
  [/thank|great|pleased|happy|brilliant|appreciate|excellent/i, 'positive']
];

const INTENT_RULES = [
  [/refund|invoice|charge|payment|billing|direct debit|overcharg/i, 'Billing'],
  [/deliver|dispatch|courier|parcel|shipping|tracking|arrived/i, 'Delivery'],
  [/return|exchange|damaged|faulty|broken|replacement/i, 'Returns'],
  [/password|login|account|access|mfa|2fa|sign in/i, 'Account'],
  [/api|error|bug|crash|not working|timeout|integration/i, 'Technical'],
  [/quote|pricing|order|purchase|bulk|upgrade/i, 'Sales']
];

function classify(rules, text, fallback) {
  for (const [pattern, value] of rules) if (pattern.test(text)) return value;
  return fallback;
}

/* Find the first present, non-empty value among candidate field names.
   Matching is case-insensitive and ignores the entity prefix, so
   "case_description", "Description" and "description" all resolve. */
export function pick(record, candidates, fallback = null) {
  const normalise = (s) => String(s).toLowerCase().replace(/^[a-z]+_/, '');
  const index = new Map();
  for (const [key, value] of Object.entries(record || {})) {
    index.set(String(key).toLowerCase(), value);
    index.set(normalise(key), value);
  }
  for (const candidate of candidates) {
    for (const key of [candidate.toLowerCase(), normalise(candidate)]) {
      const value = index.get(key);
      if (value !== undefined && value !== null && value !== '') return value;
    }
  }
  return fallback;
}

/* A linked entity arrives either as a nested object with its own fields, or as
   a bare id. Return the object when we have one. */
function linked(record, names) {
  for (const name of names) {
    const value = record?.[name];
    if (value && typeof value === 'object') return value;
  }
  return null;
}

function minutesSince(value) {
  if (!value) return 0;
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, Math.round((Date.now() - then) / 60000));
}

/* Sage CRM case status/stage vocabulary varies; map onto the four the UI uses. */
function mapStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (/closed|resolved|complete|solved/.test(s)) return 'resolved';
  if (/pending|hold|await|waiting|escalat/.test(s)) return 'pending';
  if (/new|logged|open.?new|unassigned/.test(s)) return 'new';
  return 'open';
}

export function slaMinutesFor(priority) {
  const p = String(priority || '').trim();
  const policy = config.slaPolicy;
  const hit = Object.keys(policy).find((k) => k.toLowerCase() === p.toLowerCase());
  return hit ? policy[hit] : policy.Default;
}

/* Turn one SData case record into the ticket shape the front end renders.
   Exported so it can be unit-tested without a live CRM. */
export function mapCase(record) {
  const id = pick(record, ['$key', 'case_caseid', 'caseid', 'id'], '');
  const reference = pick(record, ['case_referenceid', 'referenceid', 'reference'], null);
  const subject =
    pick(record, ['case_description', 'description', 'subject', '$title'], '') || '(no description)';
  const detail = pick(record, ['case_problemnote', 'problemnote', 'problem', 'note'], '');

  const company = linked(record, ['Company', 'company', 'PrimaryCompany']);
  const person = linked(record, ['Person', 'person', 'PrimaryPerson']);

  const customer =
    (person && pick(person, ['$title', 'pers_fullname', 'fullname', 'name'], null)) ||
    pick(record, ['case_personname', 'personname', 'contact'], null) ||
    'Unknown contact';

  const companyName =
    (company && pick(company, ['$title', 'comp_name', 'name'], null)) ||
    pick(record, ['case_companyname', 'companyname'], null) ||
    '';

  const priority = pick(record, ['case_priority', 'priority'], 'Medium');
  const opened = pick(record, ['case_opened', 'opened', 'case_createddate', 'createddate'], null);
  const status = mapStatus(pick(record, ['case_status', 'status', 'case_stage', 'stage'], ''));
  const assignee = pick(record, ['case_assigneduserid', 'assigneduserid', 'assignedto', 'assigneduser'], null);

  const searchText = `${subject} ${detail}`;
  const channelSource = String(pick(record, ['case_source', 'source', 'case_channel', 'channel'], ''));

  return {
    id: reference ? String(reference) : `CASE-${id}`,
    crmId: id,
    customer,
    account: [companyName, reference ? `Case ${reference}` : null].filter(Boolean).join(' · ') || 'No account',
    channel: classify(CHANNEL_HINTS, channelSource, 'Email'),
    subject: String(subject),
    intent: classify(INTENT_RULES, searchText, 'Other'),
    sentiment: classify(SENTIMENT_RULES, searchText, 'neutral'),
    status,
    waitMins: status === 'resolved' ? 0 : minutesSince(opened),
    slaMins: slaMinutesFor(priority),
    assignee: assignee ? String(assignee) : null,
    priority: String(priority),
    /* Populated live by /api/suggest — the CRM holds no such field. */
    aiConfidence: null,
    aiSuggestion: null,
    value: Number(pick(record, ['case_value', 'value', 'opportunity_value'], 0)) || 0,
    messages: detail
      ? [{ who: customer, at: opened ? new Date(opened).toISOString().slice(11, 16) : '', text: String(detail) }]
      : [],
    history: []
  };
}

export class SageClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl ?? config.sage.baseUrl).replace(/\/*$/, '/');
    this.user = options.user ?? config.sage.user;
    this.password = options.password ?? config.sage.password;
    this.pageSize = options.pageSize ?? config.sage.pageSize;
  }

  get authHeader() {
    return 'Basic ' + Buffer.from(`${this.user}:${this.password}`).toString('base64');
  }

  async request(path, { params = {}, signal } = {}) {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
      headers: {
        Authorization: this.authHeader,
        /* XML first: Sage CRM installs commonly reject application/json. */
        Accept: 'application/atom+xml,application/xml;q=0.9,application/json;q=0.5'
      },
      signal
    });

    const body = await response.text();

    if (!response.ok) {
      const error = new Error(
        `Sage CRM ${response.status} ${response.statusText} for ${url.pathname}` +
        (body ? ` — ${body.slice(0, 300)}` : '')
      );
      error.status = response.status;
      throw error;
    }

    return { body, contentType: response.headers.get('content-type') || '' };
  }

  /* Normalise whichever format came back into { total, startIndex, perPage,
     records }. XML is the expected case; JSON is accepted so the client still
     works against installs that serve it. */
  parse(raw) {
    const looksJson =
      raw.contentType.includes('json') || raw.body.trimStart().startsWith('{');

    if (looksJson) {
      const payload = JSON.parse(raw.body);
      return {
        total: payload?.$totalResults ?? 0,
        startIndex: payload?.$startIndex ?? 1,
        perPage: payload?.$itemsPerPage ?? 0,
        records: Array.isArray(payload?.$resources) ? payload.$resources : []
      };
    }

    return parseFeed(raw.body);
  }

  /* SData paging/filtering params. `where` uses the CRM's own column names,
     so it is passed through untouched. */
  async collection(entity, { where, orderBy, count, startIndex, signal } = {}) {
    const raw = await this.request(entity, {
      params: {
        count: count ?? this.pageSize,
        startIndex,
        where,
        orderBy
      },
      signal
    });
    return this.parse(raw);
  }

  async record(entity, id, { signal } = {}) {
    const raw = await this.request(`${entity}('${id}')`, { signal });
    return this.parse(raw).records[0] ?? null;
  }

  /* Entities exposed to web services on this install — useful for checking a
     connection and for discovering custom entity names. */
  async entities({ signal } = {}) {
    const raw = await this.request('$prototypes', { signal });
    return raw.body;
  }

  async entityFields(entity, { signal } = {}) {
    const raw = await this.request(`$prototypes/${entity}`, { signal });
    return raw.body;
  }

  /* The queue: open cases, most recently opened first. */
  async tickets({ where, signal } = {}) {
    const { records } = await this.collection('case', {
      where,
      orderBy: 'case_opened desc',
      signal
    });
    return records.map(mapCase);
  }

  /* Prior contact for a customer — the "has this person been here before?"
     panel. Communications are the CRM's record of calls, emails and meetings. */
  async historyForPerson(personId, { signal } = {}) {
    if (!personId) return [];
    const { records } = await this.collection('communication', {
      where: `comm_personid=${Number(personId)}`,
      orderBy: 'comm_datetime desc',
      count: 5,
      signal
    });
    return records.map((r) => ({
      at: String(pick(r, ['comm_datetime', 'datetime', 'date'], '')).slice(0, 10),
      text: String(pick(r, ['comm_note', 'note', 'comm_subject', 'subject', '$title'], 'Contact logged'))
    }));
  }
}
