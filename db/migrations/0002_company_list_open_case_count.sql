-- ============================================================================
-- Open care-case count on vw_crm_company_list
-- ============================================================================
-- APPLIED to WG Main.
--
-- ⚠ THIS VIEW BELONGS TO CLIENTIQ. Changed out of band; fold it into their
-- migration or their next deploy drops the column and the company card's
-- "N open care issues" goes blank.
--
-- The view has 58 columns. Rather than retype them — where one mistyped column
-- would corrupt a view several apps read — the current definition is read from
-- the catalogue and wrapped, so every existing column is preserved exactly and
-- open_cases is appended as column 59.
--
-- Appending is also all CREATE OR REPLACE VIEW permits: columns may be added to
-- the end, never inserted or reordered.
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
  v_def text;
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

  select rtrim(pg_get_viewdef('public.vw_crm_company_list'::regclass, true), ';' || chr(10) || chr(9) || ' ')
    into v_def;

  execute format(
    'create or replace view public.vw_crm_company_list as
       select base.*, coalesce(rc.open_cases, 0)::integer as open_cases
       from (%s) base
       left join (
         select company_id, count(*)::integer as open_cases
         from public.resolveiq_cases
         where status <> ''resolved''
         group by company_id
       ) rc on rc.company_id = base.company_id',
    v_def
  );
end $$;

comment on view public.vw_crm_company_list is
  'Company search and lists. open_cases is the number of unresolved ResolveIQ care cases against the company — 0, never null, so it can be rendered without a guard.';
