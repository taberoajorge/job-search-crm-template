-- Read-only results accompany vacancies; no queue-window limit or business mutation.
create index automation_work_job_triage on public.automation_work(user_id,job_id,created_at desc,id desc)
 where job_id is not null and (kind='classify' or checkpoint ? 'jev');
create function crm_private.job_triage(owner uuid,job uuid) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('state',w.state,'updated_at',w.updated_at,
  'stale',(w.policy_version is distinct from p.version or (w.checkpoint->'jev'->>'status'='completed' and w.checkpoint->'jev'->>'rubric' is distinct from 'vacancy-fit-2')),'jev',w.checkpoint->'jev')
 from public.automation_work w join public.jobs j on j.id=w.job_id and j.user_id=w.user_id
 left join public.automation_policies p on p.user_id=w.user_id
 where w.user_id=owner and owner=auth.uid() and crm_private.is_owner() and w.job_id=job
  and (w.kind='classify' or w.checkpoint ? 'jev')
 order by w.created_at desc,w.id desc limit 1;
$$;
revoke all on function crm_private.job_triage(uuid,uuid) from public,anon,authenticated;

alter function crm_private.jobs_page(uuid,jsonb) rename to jobs_page_before_triage;
create function crm_private.jobs_page(owner uuid,input jsonb) returns jsonb
language plpgsql set search_path='' as $$
declare result jsonb;items jsonb;
begin
 result=crm_private.jobs_page_before_triage(owner,input);
 if result ? 'error' then return result;end if;
 select coalesce(jsonb_agg(item||jsonb_build_object('triage',crm_private.job_triage(owner,(item->>'id')::uuid)) order by n),'[]'::jsonb)
 into items from jsonb_array_elements(result->'items') with ordinality as rows(item,n);
 return jsonb_set(result,'{items}',items);
end $$;
revoke all on function crm_private.jobs_page(uuid,jsonb) from public,anon,authenticated;

create or replace function public.crm_operation(p_operation text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null then return jsonb_build_object('error',jsonb_build_object('code','UNAUTHENTICATED','message','Sign in to continue','retryable',false));end if;
 if not crm_private.is_owner() and exists(select 1 from crm_private.settings where owner_id=auth.uid()) then return jsonb_build_object('error',jsonb_build_object('code','UNAUTHENTICATED','message','Session revoked','retryable',false));end if;
 if p_operation like 'notifications.%' then return crm_private.notification_operation(auth.uid(),p_operation,p_input);end if;
 if p_operation like 'automation.%' then return crm_private.automation_operation(auth.uid(),p_operation,p_input);end if;
 if p_operation='jobs.list' then return crm_private.jobs_page(auth.uid(),p_input);end if;
 result=crm_private.operation(auth.uid(),p_operation,p_input);
 if p_operation='jobs.get' and result ? 'id' and not result ? 'error' then
  result=result||jsonb_build_object('triage',crm_private.job_triage(auth.uid(),(result->>'id')::uuid));
 end if;
 return result;
exception when sqlstate 'CR001' then return jsonb_build_object('error',SQLERRM::jsonb);
 when invalid_text_representation then return jsonb_build_object('error',jsonb_build_object('code','UNAUTHENTICATED','message','Invalid session','retryable',false));
end $$;
