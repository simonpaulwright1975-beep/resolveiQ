-- ============================================================================
-- Cost of Failure
-- ============================================================================
-- APPLIED to WG Main.
--
-- When a case cost the business money, that cost is recorded against it. A case
-- cannot be closed until someone has said either what it cost or that it cost
-- nothing — an undecided case is the one that never gets revisited.
--
-- These are ResolveIQ's own columns on ResolveIQ's own table, so unlike the
-- vw_crm_* changes there is nothing here for another app to revert.
--
-- The gate is a CHECK constraint, not an application rule. Call iQ writes
-- through the same function, and a rule that lives only in the console is a
-- rule that holds until the day something else closes a case.
--
-- Safe to apply: resolveiq_cases had 0 rows, so nothing needed backfilling.
-- Were it not empty, every resolved case would need a cof_status first.
-- ============================================================================

alter table public.resolveiq_cases
  add column if not exists cof_status      text,
  add column if not exists cof_amount      numeric(12,2),
  add column if not exists cof_reason      text,
  add column if not exists cof_note        text,
  add column if not exists cof_recorded_at timestamptz,
  add column if not exists cof_recorded_by text;

comment on column public.resolveiq_cases.cof_status is
  'null = not yet decided. ''none'' = this case cost nothing. ''cost'' = it did, see cof_amount.';

-- The shape of a decision. "It cost nothing" carries no amount and no reason;
-- "it cost something" must carry both, or the figure is unusable for reporting.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'resolveiq_cases_cof_shape') then
    alter table public.resolveiq_cases
      add constraint resolveiq_cases_cof_shape check (
        cof_status is null
        or (cof_status = 'none' and cof_amount is null and cof_reason is null)
        or (cof_status = 'cost'
            and cof_amount is not null and cof_amount > 0
            and coalesce(btrim(cof_reason), '') <> '')
      );
  end if;
end $$;

-- The gate itself.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'resolveiq_cases_cof_before_close') then
    alter table public.resolveiq_cases
      add constraint resolveiq_cases_cof_before_close check (
        status <> 'resolved' or cof_status is not null
      );
  end if;
end $$;

-- Reporting: what failure is costing, by reason.
create index if not exists resolveiq_cases_cof_idx
  on public.resolveiq_cases (cof_status, closed_at)
  where cof_status = 'cost';
-- ----------------------------------------------------------------------------
-- The write path, updated to carry a cost-of-failure decision.
--
-- cof arrives as its own object so that "no cof key at all" (leave it alone)
-- stays distinguishable from "cof: {status: 'none'}" (decided: it cost
-- nothing). Without that distinction, every ordinary save would look like a
-- decision to clear one.
-- ----------------------------------------------------------------------------

create or replace function public.resolveiq_upsert_case(payload jsonb)
 returns jsonb
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare
  c          jsonb := coalesce(payload->'case', '{}'::jsonb);
  e          jsonb := payload->'event';
  v_ref      text  := nullif(trim(c->>'case_ref'), '');
  v_company  bigint := nullif(c->>'company_id', '')::bigint;
  v_subject  text  := nullif(trim(c->>'subject'), '');
  v_status   text  := coalesce(nullif(trim(c->>'status'), ''), 'new');
  v_case     public.resolveiq_cases;
  v_prior    public.resolveiq_cases;
  v_queue_id bigint;
  v_action   text;
  -- Cost of failure. Supplied as its own object so that "no cof key at all"
  -- (leave it alone) is distinguishable from "cof: {status: none}" (decided).
  v_cof         jsonb := c->'cof';
  v_has_cof     boolean := v_cof is not null and jsonb_typeof(v_cof) = 'object';
  v_cof_status  text;
  v_cof_amount  numeric(12,2);
  v_cof_reason  text;
  v_cof_note    text;
  v_cof_by      text;
  v_cof_at      timestamptz;
begin
  if v_company is null then
    raise exception 'company_id is required — a case with no company cannot reach a customer record'
      using errcode = '22023';
  end if;
  if v_subject is null then
    raise exception 'subject is required' using errcode = '22023';
  end if;

  if v_ref is not null then
    select * into v_prior from public.resolveiq_cases where case_ref = v_ref;
  end if;

  if v_has_cof then
    v_cof_status := nullif(trim(v_cof->>'status'), '');
    v_cof_reason := nullif(trim(v_cof->>'reason'), '');
    v_cof_note   := nullif(trim(v_cof->>'note'), '');
    v_cof_by     := nullif(trim(v_cof->>'recorded_by'), '');
    v_cof_amount := nullif(v_cof->>'amount', '')::numeric(12,2);
    v_cof_at     := now();

    if v_cof_status is not null and v_cof_status not in ('none', 'cost') then
      raise exception 'cof.status must be ''none'' or ''cost'', not %', v_cof_status
        using errcode = '22023';
    end if;
    -- "cost nothing" carries no figure: keep the row clean rather than
    -- leaving an amount behind from a previous decision.
    if v_cof_status = 'none' then
      v_cof_amount := null;
      v_cof_reason := null;
    end if;
  else
    v_cof_status := v_prior.cof_status;
    v_cof_amount := v_prior.cof_amount;
    v_cof_reason := v_prior.cof_reason;
    v_cof_note   := v_prior.cof_note;
    v_cof_by     := v_prior.cof_recorded_by;
    v_cof_at     := v_prior.cof_recorded_at;
  end if;

  -- The gate. The CHECK constraint enforces this whatever writes to the table;
  -- raising here first means the caller gets a sentence rather than a
  -- constraint name they have to go and look up.
  if v_status = 'resolved' and v_cof_status is null then
    raise exception 'This case cannot be closed until its cost of failure is recorded — either an amount and a reason, or a note that it cost nothing.'
      using errcode = '22023';
  end if;

  insert into public.resolveiq_cases as k (
    case_ref, company_id, person_id, account_ref, subject, note, category,
    channel, intent, sentiment, priority, status, owner_email, opened_at,
    resolution, next_action, ai_summary, ai_confidence, ai_escalate,
    satisfaction_score, sla_minutes, source, source_ref,
    cof_status, cof_amount, cof_reason, cof_note, cof_recorded_at, cof_recorded_by
  ) values (
    coalesce(v_ref, 'RQ-' || lpad(nextval('public.resolveiq_case_seq')::text, 5, '0')),
    v_company,
    nullif(c->>'person_id', '')::bigint,
    nullif(trim(c->>'account_ref'), ''),
    v_subject,
    c->>'note',
    c->>'category',
    c->>'channel',
    c->>'intent',
    c->>'sentiment',
    coalesce(nullif(trim(c->>'priority'), ''), 'Medium'),
    v_status,
    c->>'owner_email',
    coalesce((c->>'opened_at')::timestamptz, now()),
    c->>'resolution',
    c->>'next_action',
    c->>'ai_summary',
    (c->>'ai_confidence')::numeric,
    (c->>'ai_escalate')::boolean,
    (c->>'satisfaction_score')::integer,
    (c->>'sla_minutes')::integer,
    coalesce(nullif(trim(c->>'source'), ''), 'resolveiq'),
    nullif(trim(c->>'source_ref'), ''),
    v_cof_status, v_cof_amount, v_cof_reason, v_cof_note, v_cof_at, v_cof_by
  )
  on conflict (case_ref) do update set
    company_id         = excluded.company_id,
    person_id          = coalesce(excluded.person_id, k.person_id),
    account_ref        = coalesce(excluded.account_ref, k.account_ref),
    subject            = excluded.subject,
    note               = coalesce(excluded.note, k.note),
    category           = coalesce(excluded.category, k.category),
    channel            = coalesce(excluded.channel, k.channel),
    intent             = coalesce(excluded.intent, k.intent),
    sentiment          = coalesce(excluded.sentiment, k.sentiment),
    priority           = excluded.priority,
    status             = excluded.status,
    owner_email        = coalesce(excluded.owner_email, k.owner_email),
    resolution         = coalesce(excluded.resolution, k.resolution),
    next_action        = coalesce(excluded.next_action, k.next_action),
    ai_summary         = coalesce(excluded.ai_summary, k.ai_summary),
    ai_confidence      = coalesce(excluded.ai_confidence, k.ai_confidence),
    ai_escalate        = coalesce(excluded.ai_escalate, k.ai_escalate),
    satisfaction_score = coalesce(excluded.satisfaction_score, k.satisfaction_score),
    sla_minutes        = coalesce(excluded.sla_minutes, k.sla_minutes),
    source_ref         = coalesce(excluded.source_ref, k.source_ref),
    -- Not coalesced: a cof edit must be able to clear an amount, which
    -- coalesce would silently refuse to do. v_cof_* already falls back to the
    -- existing row when the caller sent no cof block at all.
    cof_status         = excluded.cof_status,
    cof_amount         = excluded.cof_amount,
    cof_reason         = excluded.cof_reason,
    cof_note           = excluded.cof_note,
    cof_recorded_at    = excluded.cof_recorded_at,
    cof_recorded_by    = excluded.cof_recorded_by,
    updated_at         = now()
  returning * into v_case;

  if v_case.status = 'resolved' and v_case.closed_at is null then
    update public.resolveiq_cases set closed_at = now()
    where id = v_case.id returning * into v_case;
  end if;

  if e is not null and jsonb_typeof(e) = 'object' then
    insert into public.resolveiq_case_events (case_id, kind, direction, author, body, occurred_at, metadata)
    values (
      v_case.id,
      coalesce(nullif(trim(e->>'kind'), ''), 'note'),
      nullif(trim(e->>'direction'), ''),
      nullif(trim(e->>'author'), ''),
      e->>'body',
      coalesce((e->>'occurred_at')::timestamptz, now()),
      coalesce(e->'metadata', '{}'::jsonb)
    );

    if v_case.first_response_at is null and e->>'direction' = 'outbound' then
      update public.resolveiq_cases set first_response_at = now()
      where id = v_case.id returning * into v_case;
    end if;
  end if;

  if v_case.status = 'resolved' and v_case.sage_queue_id is null then
    v_action := case
      when lower(coalesce(v_case.channel, '')) = 'voice' then 'Phone'
      when lower(coalesce(v_case.channel, '')) = 'email' then 'Email'
      else 'Note'
    end;

    begin
      v_queue_id := public.crm_queue_change(
        p_entity    => 'communication',
        p_operation => 'create',
        p_payload   => jsonb_build_object(
          'comm_subject', 'Customer care ' || v_case.case_ref || ' — ' || v_case.subject,
          'comm_note',    coalesce(v_case.resolution, v_case.ai_summary, v_case.note, ''),
          'comm_action',  v_action,
          'comm_status',  'Complete'
        ),
        p_source_app => 'resolveiq',
        p_company_id => v_case.company_id,
        p_person_id  => v_case.person_id
      );

      update public.resolveiq_cases
      set sage_queue_id = v_queue_id, sage_queued_at = now()
      where id = v_case.id returning * into v_case;
    exception when others then
      v_queue_id := null;
    end;
  end if;

  return jsonb_build_object(
    'case', to_jsonb(v_case),
    'queued_to_sage', v_case.sage_queue_id is not null,
    'sage_queue_id', v_case.sage_queue_id
  );
end;
$function$;
