-- ============================================================================
-- Reps may read their own calls
-- ============================================================================
-- APPLIED to WG Main.
--
-- ⚠ SHARED INFRASTRUCTURE. dialpad_calls belongs to Call iQ. Applied from the
-- ResolveIQ side at the owner's request; fold it into Call iQ's migrations.
--
-- Makes the Realtime push of 0003 usable from a browser. Before this,
-- dialpad_calls had RLS enabled with zero policies, so only the service role
-- could read it and an authenticated subscriber received nothing.
--
-- Verified by impersonating a signed-in rep against the live table: they see
-- 1,461 calls — exactly their own — and none of the 1,317 belonging to other
-- reps. No leak.
--
-- SELECT only. Setting dismissed_at or logged_call_id from the browser would
-- need an UPDATE policy; that is a larger grant and is not made here.
--
-- ⚠ COVERAGE. This policy cannot show what the data does not record:
--
--     rep_email null on 3,227 of 6,005 calls        54%
--     inbound calls attributed to a rep             30.1%  (499 of 1,658)
--
-- Inbound is exactly the customer-service case, so seven in ten of the calls
-- this feature exists for are invisible to every rep. The wrap-up card will not
-- appear for them.
--
-- The fix is upstream — populate rep_email on inbound calls in the Dialpad
-- sync. Widening the policy to include unattributed rows would expose 3,227
-- calls, with customer phone numbers, to every signed-in WG account; that is a
-- decision for whoever owns the data, not a workaround to apply quietly.
-- ============================================================================

create policy dialpad_calls_own_calls on public.dialpad_calls
  for select
  to authenticated
  using (lower(rep_email) = lower(auth.jwt() ->> 'email'));

comment on table public.dialpad_calls is
  'Dialpad call records. RLS: a signed-in rep may SELECT their own calls (dialpad_calls_own_calls); everything else is service-role only. Calls with a null rep_email are visible to nobody through the API.';
