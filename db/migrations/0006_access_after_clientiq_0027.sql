-- ============================================================================
-- Restore ResolveIQ's writes, and close the gap 0027 left on case events
-- ============================================================================
-- APPLIED to WG Main.
--
-- ClientiQ's 0027_clientiq_access.sql locked the customer book down to a
-- curated list (public.clientiq_access, via public.clientiq_can_read()). That
-- was right, and this migration keeps it — it does not loosen anything 0027
-- decided.
--
-- Two consequences it did not intend:
--
-- 1. resolveiq_cases went from a policy for ALL commands to one for SELECT
--    only. resolveiq_upsert_case is SECURITY INVOKER, so it runs as the
--    signed-in user — which meant ResolveIQ could read the queue and write
--    nothing. Raising a case, resolving one, recording a cost of failure and
--    storing a satisfaction score were all silently denied. Verified: a probe
--    insert as a real account created 0 rows while reads returned fine.
--
-- 2. resolveiq_case_events was left on its original `using (true)` policy for
--    ALL commands. It holds case notes and the customer's own messages, and
--    every one of the project's accounts could read and write it — including
--    the five non-hub logins 0027 exists to shut out. Tightening the parent
--    table and not the child left the more sensitive of the two open.
--
-- Both are ResolveIQ's own tables, so the fix belongs here rather than in
-- ClientiQ's chain.
--
-- The gate is ClientiQ's own clientiq_can_read(), deliberately: a second
-- access list would drift from the first, and the question "may this person
-- see customer data" should have one answer.
--
-- Net effect on access is TIGHTER than before 0027, not looser. Case events
-- go from any authenticated account to the seven on the list; cases stay on
-- the list for reads and join it for writes.
-- ============================================================================

do $$
begin
  if to_regproc('public.clientiq_can_read') is null then
    raise exception
      'public.clientiq_can_read() is missing — apply ClientiQ 0027_clientiq_access.sql first';
  end if;
end $$;

-- ── Cases: keep 0027's SELECT policy, add the writes back ───────────────────
-- Left as separate INSERT and UPDATE policies rather than one FOR ALL, so
-- that ClientiQ's resolveiq_cases_read stays the single definition of who may
-- read, and a future change to reads does not silently change writes.
drop policy if exists resolveiq_cases_insert on public.resolveiq_cases;
create policy resolveiq_cases_insert on public.resolveiq_cases
  for insert to authenticated
  with check (public.clientiq_can_read());

drop policy if exists resolveiq_cases_update on public.resolveiq_cases;
create policy resolveiq_cases_update on public.resolveiq_cases
  for update to authenticated
  using (public.clientiq_can_read())
  with check (public.clientiq_can_read());

-- Deliberately no DELETE policy. A raised case is part of a customer's
-- history; finishing one is resolving it, not removing it. The smoke test
-- deletes its own row as service_role, which bypasses RLS.

-- ── Case events: replace the open policy with the same gate ─────────────────
drop policy if exists resolveiq_case_events_authenticated on public.resolveiq_case_events;

drop policy if exists resolveiq_case_events_read on public.resolveiq_case_events;
create policy resolveiq_case_events_read on public.resolveiq_case_events
  for select to authenticated
  using (public.clientiq_can_read());

drop policy if exists resolveiq_case_events_insert on public.resolveiq_case_events;
create policy resolveiq_case_events_insert on public.resolveiq_case_events
  for insert to authenticated
  with check (public.clientiq_can_read());

comment on table public.resolveiq_case_events is
  'What was done on a case. Gated on clientiq_can_read() — it carries case '
  'notes and customer messages, so it is at least as sensitive as the case.';
