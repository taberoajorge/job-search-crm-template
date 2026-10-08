-- Pending work has a definite freshness state, even before a provider response exists.
create or replace function crm_private.job_triage(owner uuid,job uuid) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('state',w.state,'updated_at',w.updated_at,
  'stale',(w.policy_version is distinct from p.version or (coalesce(w.checkpoint->'jev'->>'status'='completed',false) and w.checkpoint->'jev'->>'rubric' is distinct from 'vacancy-fit-2')),'jev',w.checkpoint->'jev')
 from public.automation_work w join public.jobs j on j.id=w.job_id and j.user_id=w.user_id
 left join public.automation_policies p on p.user_id=w.user_id
 where w.user_id=owner and owner=auth.uid() and crm_private.is_owner() and w.job_id=job
  and (w.kind='classify' or w.checkpoint ? 'jev')
 order by w.created_at desc,w.id desc limit 1;
$$;
