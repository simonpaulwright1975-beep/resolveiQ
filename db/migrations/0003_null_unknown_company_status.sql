-- ============================================================================
-- Company status is unknown, so record it as unknown
-- ============================================================================
-- APPLIED.
--
-- The 0002 backfill mapped Sage's account_status to 'customer' / 'closed'.
-- Checking the source afterwards showed account_status is 0 for all 2,669
-- rows — one distinct value, so it carries no information, and every company
-- was labelled 'customer' on the strength of it.
--
-- Nor can order recency stand in: public.sage_orders holds OPEN orders (1,595
-- lines, 350 accounts, dates running forward to 2027), not order history, so
-- absence from it does not mean lapsed.
--
-- NULL means unknown. An advisor seeing a blank status asks the question; an
-- advisor seeing a wrong one does not.
-- ============================================================================

update core.companies
set status = null, updated_at = now()
where source = 'sage' and status = 'customer';

comment on column core.companies.status is
  'customer | prospect | lapsed | closed. NULL means unknown. Sage account_status is uniformly 0 on this install so it cannot populate this, and sage_orders holds open orders only, so order recency cannot infer lapsed. Needs a real source before it is shown as fact.';

comment on column core.companies.postcode is
  'Not populated by the Sage customer sync — sage_customers has address columns but all 2,669 rows are empty. The sync needs extending on WG-SQL-01 before addresses appear on a customer card.';
