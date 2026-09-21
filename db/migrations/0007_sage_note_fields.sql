-- 0007  Queue Sage CRM notes that Sage CRM will actually accept
--
-- Three faults in what resolveiq_upsert_case puts on the outbox, found by
-- comparing it against Call iQ's working payload and against the 38,644
-- communications already mirrored from Sage CRM.
--
--   1. comm_action was 'Phone', 'Email' or 'Note'. None of those exist in
--      Sage CRM. Its list is 'Phone Out' (22,419 rows), 'Email Out' (672),
--      'Customer Service Call' (10), and so on. Call iQ sends 'Phone Out'.
--
--   2. comm_datetime was not sent at all, so the note would carry the time
--      the worker pushed it rather than the time the case was closed.
--
--   3. A failure to queue was swallowed whole: the case closed, Cerian saw
--      it done, and nothing ever reached Sage CRM. It is recorded now, and
--      handed back to the caller, without failing the close.
--
-- comm_status 'Complete' was already right (34,082 rows use it) and is
-- unchanged. Nothing here alters the worker: crm_outbox_claim takes whatever
-- is pending, with no filter on source_app.

alter table public.resolveiq_cases
  add column if not exists sage_queue_error     text,
  add column if not exists sage_queue_failed_at timestamptz;

comment on column public.resolveiq_cases.sage_queue_error is
  'Why the Sage CRM note could not be queued. Null when it queued, or when no attempt has been made yet.';

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
    /* comm_action is a lookup in Sage CRM, not free text. These three are
       values Sage CRM already holds — 'Phone Out' and 'Email Out' are its two
       busiest, and 'Customer Service Call' is the one that names this work.
       The previous 'Phone'/'Email'/'Note' matched nothing in the list. */
    v_action := case
      when lower(coalesce(v_case.channel, '')) = 'voice' then 'Phone Out'
      when lower(coalesce(v_case.channel, '')) = 'email' then 'Email Out'
      else 'Customer Service Call'
    end;

    begin
      v_queue_id := public.crm_queue_change(
        p_entity    => 'communication',
        p_operation => 'create',
        p_payload   => jsonb_build_object(
          'comm_subject', 'Customer care ' || v_case.case_ref || ' — ' || v_case.subject,
          'comm_note',    coalesce(v_case.resolution, v_case.ai_summary, v_case.note, ''),
          'comm_action',  v_action,
          'comm_status',  'Complete',
          /* When the case was actually closed, not when the worker gets round
             to pushing it. Without this Sage CRM stamps the push time, so a
             Friday case pushed on Monday reads as Monday's work. */
          'comm_datetime', to_char(coalesce(v_case.closed_at, now())
                                     at time zone 'utc',
                                   'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        ),
        p_source_app => 'resolveiq',
        p_company_id => v_case.company_id,
        p_person_id  => v_case.person_id
      );

      update public.resolveiq_cases
      set sage_queue_id = v_queue_id, sage_queued_at = now(),
          sage_queue_error = null, sage_queue_failed_at = null
      where id = v_case.id returning * into v_case;
    exception when others then
      /* Closing the case must not fail because the outbox is unreachable —
         but the failure is recorded rather than swallowed. This only ever
         runs once per case (sage_queue_id is null), so a silent miss here
         was permanent and invisible. */
      v_queue_id := null;
      update public.resolveiq_cases
      set sage_queue_error = left(coalesce(sqlerrm, 'unknown error'), 500),
          sage_queue_failed_at = now()
      where id = v_case.id returning * into v_case;
    end;
  end if;

  return jsonb_build_object(
    'case', to_jsonb(v_case),
    'queued_to_sage', v_case.sage_queue_id is not null,
    'sage_queue_id', v_case.sage_queue_id,
    'sage_queue_error', v_case.sage_queue_error
  );
end;
$function$;


comment on function public.resolveiq_upsert_case(jsonb) is
  'Upsert a case, append an event, and queue a Sage CRM note once it resolves. Sends only comm_action values Sage CRM actually holds.';
