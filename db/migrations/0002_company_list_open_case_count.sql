-- ============================================================================
-- Open care-case count on vw_crm_company_list
-- ============================================================================
-- APPLIED to WG Main. RE-APPLIED 2026-09-15 after a ClientiQ deploy dropped it.
--
-- ⚠ THIS VIEW BELONGS TO CLIENTIQ. Changed out of band. It has already been
-- reverted once: ClientiQ redeployed the view on/before 15 Sep 2026 — adding
-- spend, margin and product-line columns — and open_cases went with it. Fold
-- this into their migration or it will keep happening.
--
-- The view is large and its shape is ClientiQ's to change. Rather than retype
-- it — where one mistyped column would corrupt a view several apps read — the
-- current definition is read from the catalogue and wrapped, so every existing
-- column is preserved exactly, whatever ClientiQ last deployed, and open_cases
-- is appended as the final column.
--
-- Appending is also all CREATE OR REPLACE VIEW permits: columns may be added to
-- the end, never inserted or reordered.
--
-- ⚠ reloptions ARE CARRIED THROUGH. vw_crm_company_list is security_invoker=true
-- and a bare CREATE OR REPLACE VIEW resets reloptions to empty — which would
-- silently make it a security-DEFINER view, running as the owner and bypassing
-- RLS for every app that reads it. An earlier version of this migration had
-- exactly that defect. The options are read from pg_class and re-applied.
--
-- The count is a grouped aggregate joined once, not a correlated subquery. This
-- view already sequential-scans 28,005 companies; a per-row subquery would run
-- 28,005 times. Measured on a name search: 53.0 ms before, 48.7 ms after.
--
-- Re-runnable: it does nothing if open_cases is already there, so it cannot
-- wrap itself twice.
-- ============================================================================

do $$
declare
  v_def     text;
  v_opts    text[];
  v_with    text := '';
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'vw_crm_company_list'
      and column_name = 'open_cases'
  ) then
    raise notice 'open_cases already present — nothing to do';
    return;
  end if;

  select rtrim(pg_get_viewdef('public.vw_crm_company_list'::regclass, true), ';' || chr(10) || chr(9) || ' '),
         c.reloptions
    into v_def, v_opts
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'vw_crm_company_list';

  -- Preserve security_invoker and anything else set on the view. Without this
  -- the replacement runs as the view owner and RLS stops applying.
  if v_opts is not null and array_length(v_opts, 1) > 0 then
    v_with := ' with (' || array_to_string(v_opts, ', ') || ')';
  end if;

  execute format(
    'create or replace view public.vw_crm_company_list%s as
       select base.*, coalesce(rc.open_cases, 0)::integer as open_cases
       from (%s) base
       left join (
         select company_id, count(*)::integer as open_cases
         from public.resolveiq_cases
         where status <> ''resolved''
         group by company_id
       ) rc on rc.company_id = base.company_id',
    v_with, v_def
  );

  raise notice 'open_cases appended; view options carried through: %',
    coalesce(array_to_string(v_opts, ', '), '(none)');
end $$;

-- Verify the option survived, rather than trusting that it did.
do $$
declare v_opts text[];
begin
  select c.reloptions into v_opts
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'vw_crm_company_list';

  if not (coalesce(array_to_string(v_opts, ','), '') like '%security_invoker=true%') then
    raise exception 'vw_crm_company_list lost security_invoker — refusing to leave it security-definer';
  end if;
end $$;

comment on view public.vw_crm_company_list is
  'Company search and lists. open_cases is the number of unresolved ResolveIQ care cases against the company — 0, never null, so it can be rendered without a guard.';
