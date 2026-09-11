-- ============================================================================
-- Backfill core.companies from the existing Sage customer sync
-- ============================================================================
-- Run after 0001. Safe to run repeatedly — it matches on account_ref and
-- updates in place, so re-running refreshes rather than duplicating.
--
-- This is what makes the central record real rather than empty: 2,669
-- customers exist in public.sage_customers already.
--
-- It deliberately does NOT touch rows marked source='manual'. Once someone
-- edits a company here, the Sage sync stops overwriting it — otherwise the
-- nightly sync quietly undoes people's work, which is the classic way a
-- two-system transition loses data.
-- ============================================================================

insert into core.companies (
  account_ref, sage_customer_id, name, telephone, general_email,
  address_line1, address_line2, town, postcode, status, source
)
select
  s.account_ref,
  s.customer_id,
  coalesce(nullif(trim(s.customer_name), ''), s.account_ref),
  nullif(trim(s.telephone), ''),
  nullif(trim(s.email), ''),
  nullif(trim(s.address_line1), ''),
  nullif(trim(s.address_line2), ''),
  nullif(trim(s.town), ''),
  nullif(trim(s.postcode), ''),
  /* Deliberately NULL. account_status is 0 for all 2,669 rows on this
     install — a single distinct value carries no information, and a blank
     status is better than a confident wrong one. See 0003. */
  null,
  'sage'
from public.sage_customers s
where s.account_ref is not null
  and trim(s.account_ref) <> ''
on conflict (account_ref) do update set
  sage_customer_id = excluded.sage_customer_id,
  name             = excluded.name,
  telephone        = coalesce(excluded.telephone, core.companies.telephone),
  general_email    = coalesce(excluded.general_email, core.companies.general_email),
  address_line1    = coalesce(excluded.address_line1, core.companies.address_line1),
  address_line2    = coalesce(excluded.address_line2, core.companies.address_line2),
  town             = coalesce(excluded.town, core.companies.town),
  postcode         = coalesce(excluded.postcode, core.companies.postcode),
  updated_at       = now()
where core.companies.source = 'sage';

-- Last order date, where the order history can tell us.
update core.companies c
set last_order_at = o.last_order,
    updated_at    = now()
from (
  select account_ref, max(order_date)::timestamptz as last_order
  from public.sage_orders
  where account_ref is not null
  group by account_ref
) o
where o.account_ref = c.account_ref
  and c.source = 'sage'
  and (c.last_order_at is distinct from o.last_order);

-- Contacts, where the Sage CRM person sync has run. crm_contacts is empty at
-- the time of writing, so this is a no-op until that sync is populated — it is
-- here so the backfill is complete once it is.
insert into core.contacts (
  company_id, sage_person_id, first_name, last_name, full_name,
  job_title, email, telephone, mobile, is_primary, last_spoken_at, source
)
select
  c.id,
  p.person_id,
  nullif(trim(p.first_name), ''),
  nullif(trim(p.last_name), ''),
  coalesce(
    nullif(trim(p.full_name), ''),
    nullif(trim(concat_ws(' ', p.first_name, p.last_name)), '')
  ),
  nullif(trim(p.job_title), ''),
  nullif(trim(p.email), ''),
  nullif(trim(p.phone), ''),
  nullif(trim(p.mobile), ''),
  coalesce(p.is_primary, false),
  p.last_spoken_at,
  'sage'
from public.crm_contacts p
join core.companies c on c.account_ref = p.account_ref
where p.account_ref is not null
  and not exists (
    select 1 from core.contacts existing
    where existing.sage_person_id = p.person_id
  );
