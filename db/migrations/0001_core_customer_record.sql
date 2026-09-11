-- ============================================================================
-- The shared WG customer record
-- ============================================================================
-- Target: the "WG Main" Supabase project (hlfhyzqkzqgyuohhmzzu).
--
-- NOT YET APPLIED. Review first — this adds a new schema to a live database
-- that several applications already use.
--
-- Why a new `core` schema rather than resolveiq_* tables in public:
--
--   public already shows what happens without one — meetiq_customers,
--   appt_customers, rebates_customers, reorder_customers, brochures_customers,
--   donna_customer_extras, plus contacts / crm_contacts / meetiq_contacts /
--   benchmark_contacts. Every app brought its own customer table. Adding
--   resolveiq_customers would repeat exactly the mistake we are trying to stop.
--
--   `core` is the one place a customer exists. Apps read it; they do not copy
--   it. The name is arbitrary and easy to change before this is applied.
--
-- What already exists and is NOT duplicated here:
--
--   public.sage_customers      2,669 rows — the customer master, synced from Sage
--   public.crm_communications  26,388 rows across 1,615 accounts — contact history
--   public.dialpad_calls       5,771 rows — calls, with customer_account_match
--   public.call_transcripts    772 rows — transcripts
--   public.crm_comm_pushes     the Sage push queue (Call iQ → Sage)
--
--   account_ref (the Sage account reference) is already the join key across all
--   of them. core keeps it, so everything joins from day one.
--
-- The Sage-independence move:
--
--   sage_customers is a mirror — its identity is Sage's customer_id, and it is
--   overwritten by the sync. A record whose identity belongs to Sage cannot
--   outlive Sage. core.companies owns its own id, and treats account_ref as ONE
--   identifier among several. When Sage goes, account_ref becomes just another
--   legacy code and nothing else changes.
-- ============================================================================

create schema if not exists core;
comment on schema core is
  'The shared WG customer record. One company, one contact, one case — used by ResolveIQ, Call iQ, MarketingiQ, PageiQ and the new CRM. Not app-specific.';

-- ---------------------------------------------------------------------------
-- Companies
-- ---------------------------------------------------------------------------

create table if not exists core.companies (
  id                  uuid primary key default gen_random_uuid(),

  -- Legacy identifiers. account_ref is the current spine; both become
  -- ordinary reference data once Sage is retired.
  account_ref         text unique,
  sage_customer_id    bigint,
  sage_crm_company_id bigint,

  name                text not null,
  status              text,          -- customer | prospect | lapsed | closed
  sector              text,
  customer_type       text,

  account_owner_email   text,        -- sales owner
  service_owner_email   text,        -- customer service owner

  telephone           text,
  website             text,
  general_email       text,

  address_line1       text,
  address_line2       text,
  town                text,
  county              text,
  postcode            text,
  country             text,

  customer_since      date,
  last_order_at       timestamptz,

  notes               text,

  -- Where this row came from, so a sync never silently overwrites hand-entered
  -- data: 'sage' rows may be refreshed, 'manual' rows may not.
  source              text not null default 'sage',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on column core.companies.account_ref is
  'Sage account reference. The estate-wide join key today; legacy reference data once Sage is retired.';
comment on column core.companies.source is
  'sage = maintained by the Sage sync and safe to refresh. manual = entered here; the sync must not overwrite it.';

create index if not exists companies_name_idx on core.companies (lower(name));
create index if not exists companies_status_idx on core.companies (status);

-- ---------------------------------------------------------------------------
-- Contacts — people sitting under a company
-- ---------------------------------------------------------------------------

create table if not exists core.contacts (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references core.companies (id) on delete cascade,

  -- Denormalised so anything still keyed on account_ref can join directly
  -- during the transition. Kept in step by a trigger below.
  account_ref       text,
  sage_person_id    bigint,

  first_name        text,
  last_name         text,
  full_name         text,
  job_title         text,

  email             text,
  telephone         text,
  mobile            text,

  is_primary        boolean not null default false,
  is_decision_maker boolean not null default false,
  is_purchasing     boolean not null default false,
  is_accounts       boolean not null default false,

  -- Marketing permission is a compliance record, so it carries its own
  -- timestamp and basis rather than a bare boolean.
  marketing_opt_in     boolean,
  marketing_opt_in_at  timestamptz,
  marketing_basis      text,        -- consent | legitimate_interest | contract
  marketing_prefs      jsonb not null default '{}'::jsonb,

  notes             text,
  last_spoken_at    timestamptz,

  source            text not null default 'sage',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists contacts_company_idx on core.contacts (company_id);
create index if not exists contacts_account_ref_idx on core.contacts (account_ref);
create index if not exists contacts_email_idx on core.contacts (lower(email));

-- ---------------------------------------------------------------------------
-- Cases — the ResolveIQ domain, and the one thing genuinely missing today
-- ---------------------------------------------------------------------------

create table if not exists core.cases (
  id                 uuid primary key default gen_random_uuid(),
  case_ref           text unique,               -- human-facing reference

  company_id         uuid references core.companies (id) on delete set null,
  contact_id         uuid references core.contacts (id) on delete set null,
  account_ref        text,                      -- transition join key

  subject            text not null,
  detail             text,
  category           text,
  channel            text,                      -- Chat | Email | Voice
  intent             text,
  sentiment          text,                      -- positive|neutral|frustrated|angry

  priority           text not null default 'Medium',
  status             text not null default 'new',  -- new|open|pending|resolved

  owner_email        text,

  raised_at          timestamptz not null default now(),
  first_response_at  timestamptz,
  resolved_at        timestamptz,
  sla_minutes        integer,

  resolution         text,
  next_action        text,
  next_action_due    date,

  ai_summary         text,
  ai_confidence      numeric(3,2),
  ai_escalate        boolean,

  satisfaction_score integer,                   -- 1–5 where captured
  satisfaction_note  text,

  -- Set when this case has been mirrored into Sage, so the push is idempotent
  -- and we never create the same communication twice.
  sage_comm_id       bigint,
  sage_pushed_at     timestamptz,

  source             text not null default 'resolveiq',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint cases_status_check
    check (status in ('new','open','pending','resolved')),
  constraint cases_satisfaction_check
    check (satisfaction_score is null or satisfaction_score between 1 and 5)
);

create index if not exists cases_company_idx on core.cases (company_id);
create index if not exists cases_account_ref_idx on core.cases (account_ref);
create index if not exists cases_status_idx on core.cases (status) where status <> 'resolved';
create index if not exists cases_raised_idx on core.cases (raised_at desc);

comment on column core.cases.sage_comm_id is
  'Set once mirrored into Sage CRM. Presence of this value means do not push again.';

-- ---------------------------------------------------------------------------
-- Case events — what was actually done, internal and customer-facing
-- ---------------------------------------------------------------------------

create table if not exists core.case_events (
  id           uuid primary key default gen_random_uuid(),
  case_id      uuid not null references core.cases (id) on delete cascade,

  occurred_at  timestamptz not null default now(),
  kind         text not null,   -- note|customer_message|internal_note|action|
                                -- status_change|ai_draft|escalation
  direction    text,            -- inbound | outbound | internal
  author       text,            -- user email, or 'resolveiq' for AI
  body         text,
  metadata     jsonb not null default '{}'::jsonb,

  created_at   timestamptz not null default now()
);

create index if not exists case_events_case_idx on core.case_events (case_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- Keep updated_at honest
-- ---------------------------------------------------------------------------

create or replace function core.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists companies_touch on core.companies;
create trigger companies_touch before update on core.companies
  for each row execute function core.touch_updated_at();

drop trigger if exists contacts_touch on core.contacts;
create trigger contacts_touch before update on core.contacts
  for each row execute function core.touch_updated_at();

drop trigger if exists cases_touch on core.cases;
create trigger cases_touch before update on core.cases
  for each row execute function core.touch_updated_at();

-- Keep the denormalised account_ref on contacts in step with its company.
create or replace function core.sync_contact_account_ref()
returns trigger
language plpgsql
as $$
begin
  select c.account_ref into new.account_ref
  from core.companies c where c.id = new.company_id;
  return new;
end;
$$;

drop trigger if exists contacts_sync_ref on core.contacts;
create trigger contacts_sync_ref before insert or update of company_id on core.contacts
  for each row execute function core.sync_contact_account_ref();

-- ---------------------------------------------------------------------------
-- The customer timeline
-- ---------------------------------------------------------------------------
-- Extends the pattern public.vw_customer_conversations already established
-- (normalise every source to one row shape, UNION ALL them).
--
-- This is a NEW view rather than a replacement: vw_customer_conversations is
-- in use, and changing a view other apps read is not something to do as a side
-- effect of adding cases.
--
-- A view, not a table — the timeline is never copied, so it cannot drift from
-- the sources. If it gets slow, it becomes a materialized view; the shape the
-- apps read does not change.

create or replace view core.customer_timeline as

  -- Sage CRM communications, synced down (26k rows today)
  select
    'sage_crm'::text          as source,
    c.comm_id::text           as source_id,
    c.account_ref,
    c.occurred_at,
    coalesce(c.comm_type, 'Communication') as kind,
    c.subject,
    c.note                    as body,
    c.logged_by,
    null::text                as outcome,
    null::text                as next_action,
    null::uuid                as case_id
  from public.crm_communications c
  where c.account_ref is not null

  union all

  -- ReorderRadar call log
  select
    'reorderradar', d.id::text, d.account_code, d.called_at, 'Call',
    d.product_focus, d.notes, d.called_by, d.outcome, d.next_action, null::uuid
  from public.donna_call_log d
  where d.account_code is not null

  union all

  -- Call iQ / Dialpad calls, with the AI recap as the body
  select
    'calliq',
    dc.id::text,
    dc.customer_account_match,
    dc.started_at,
    case when dc.direction = 'inbound' then 'Inbound call' else 'Outbound call' end,
    null::text,
    dc.recap_summary,
    null::text,
    null::text,
    null::text,
    null::uuid
  from public.dialpad_calls dc
  where dc.customer_account_match is not null

  union all

  -- ResolveIQ cases: raising one is a timeline event
  select
    'resolveiq',
    k.id::text,
    k.account_ref,
    k.raised_at,
    'Case raised',
    k.subject,
    coalesce(k.ai_summary, k.detail),
    k.owner_email,
    k.resolution,
    k.next_action,
    k.id
  from core.cases k
  where k.account_ref is not null

  union all

  -- and so is anything done on it that faced the customer
  select
    'resolveiq',
    e.id::text,
    k.account_ref,
    e.occurred_at,
    e.kind,
    k.subject,
    e.body,
    e.author,
    null::text,
    null::text,
    k.id
  from core.case_events e
  join core.cases k on k.id = e.case_id
  where k.account_ref is not null
    and e.kind in ('customer_message','action','escalation','status_change');

comment on view core.customer_timeline is
  'Everything Walter Geering has done with a customer, newest-first when ordered. Add a source by adding a UNION ALL branch — never by copying rows into a table.';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- Enabled with no permissive policy: nothing reaches the anon or authenticated
-- roles until a policy is written deliberately. Server-side callers using the
-- service role key bypass RLS and keep working.
-- This matches the rest of the database, where every public table has RLS on.

alter table core.companies   enable row level security;
alter table core.contacts    enable row level security;
alter table core.cases       enable row level security;
alter table core.case_events enable row level security;
