-- ============================================================================
-- ResolveIQ cases in vw_crm_company_activity
-- ============================================================================
-- APPLIED to WG Main.
--
-- ⚠ THIS VIEW BELONGS TO CLIENTIQ. It was changed here out of band. Whoever
-- owns ClientiQ's migrations should fold this branch into their own definition,
-- or the next deploy of theirs will silently drop ResolveIQ off the feed.
--
-- The two existing branches are reproduced exactly; only a third UNION ALL is
-- added. Verified before and after: sage_crm 34,338 rows and calliq 2,004 rows,
-- unchanged.
--
-- Two decisions worth knowing:
--
-- comm_id is NEGATED (-case_no). The feed keys rows on a bigint comm_id, and
-- cases have a uuid. Sage comm_ids are positive, so a negative number cannot
-- collide, and a row's provenance is obvious at a glance.
--
-- Dedup is by whether the mirrored Sage communication EXISTS, not by whether it
-- has been queued. Resolving a case queues a Sage communication that lands
-- about five minutes later; keying on "queued" would blank the case from the
-- customer's record during that window, and keying on nothing would leave every
-- resolved case on the timeline twice, for ever.
-- ============================================================================

create or replace view public.vw_crm_company_activity as
 WITH merged AS (
         SELECT m.comm_id, m.company_id, m.person_id, m.comm_type, m.comm_action,
            m.status, m.occurred_at, m.completed_at, m.ends_at, m.outcome,
            m.priority, m.location, m.call_type, m.subject, m.note, m.logged_by,
            NULL::text AS account_ref_raw,
            NULL::text AS company_name_raw,
            NULL::text AS contact_name,
            m.completed_at IS NULL AS is_scheduled,
            m.synced_at AS feed_synced_at,
            'sage_crm'::text AS source
           FROM sage_crm.communications m
          WHERE m.deleted = false
        UNION ALL
         SELECT k.comm_id, k.crm_company_id, NULL::bigint AS int8, k.comm_type,
            k.comm_action, k.status, k.occurred_at,
            NULL::timestamp with time zone AS timestamptz,
            NULL::timestamp with time zone AS timestamptz,
            NULL::text AS text, NULL::text AS text, NULL::text AS text,
            NULL::text AS text, k.subject, k.note, k.logged_by,
            k.account_ref, k.company_name, k.contact_name,
            (k.status = ANY (ARRAY['Pending'::text, 'In Progress'::text])) OR k.occurred_at > k.synced_at,
            k.synced_at,
            'calliq'::text AS text
           FROM crm_communications k
          WHERE NOT (EXISTS ( SELECT 1
                   FROM sage_crm.communications m
                  WHERE m.comm_id = k.comm_id))
        UNION ALL
         SELECT (- r.case_no),          -- negative: cannot collide with Sage
            r.company_id,
            r.person_id,
            'Case'::text,
            r.channel,                  -- Email | Voice | Chat
            r.status,                   -- new | open | pending | resolved
            r.opened_at,
            r.closed_at,
            NULL::timestamp with time zone,
            r.resolution,               -- what was done, as the outcome
            r.priority,
            NULL::text,
            NULL::text,
            r.subject,
            COALESCE(r.note, r.ai_summary),
            r.owner_email,
            r.account_ref,
            NULL::text,                 -- company name comes from the join
            NULL::text,                 -- contact name comes from the join
            false,                      -- a case is open, not diarised
            r.updated_at,
            'resolveiq'::text
           FROM public.resolveiq_cases r
          WHERE NOT (EXISTS ( SELECT 1
                   FROM sage_crm.outbox o
                     JOIN sage_crm.communications m ON m.comm_id = o.sage_crm_id
                  WHERE o.id = r.sage_queue_id
                    AND o.sage_crm_id IS NOT NULL))
        )
 SELECT x.comm_id,
    COALESCE(c.company_id, x.company_id) AS company_id,
    COALESCE(c.name, x.company_name_raw) AS company_name,
    COALESCE(c.account_ref, x.account_ref_raw) AS account_ref,
    COALESCE(p.full_name, x.contact_name) AS contact_name,
    x.comm_type, x.comm_action, x.status,
    COALESCE(x.completed_at, x.occurred_at) AS occurred_at,
    x.completed_at, x.ends_at, x.outcome, x.priority, x.location, x.call_type,
    x.subject, x.note, x.logged_by, x.is_scheduled, x.feed_synced_at, x.source
   FROM merged x
     LEFT JOIN sage_crm.companies c ON c.company_id = x.company_id OR x.company_id IS NULL AND x.account_ref_raw IS NOT NULL AND c.account_ref = x.account_ref_raw
     LEFT JOIN sage_crm.persons p ON p.person_id = x.person_id AND p.deleted = false;

comment on view public.vw_crm_company_activity is
  'Every call, task, email and care case logged against a company, newest first when ordered. Sources: sage_crm, calliq, resolveiq. ResolveIQ rows carry a NEGATIVE comm_id (-case_no) so they cannot collide with a Sage CRM comm_id, and drop out once their mirrored Sage communication exists.';
