-- Independent classifier toggle; retain the existing guarded policy persistence and flow scheduler.
alter function crm_private.validate_automation_policy(jsonb,uuid) rename to validate_automation_policy_before_jev;
create function crm_private.validate_automation_policy(p jsonb,owner uuid) returns void language plpgsql set search_path='' as $$
begin
 if p ? 'jev_enabled' and jsonb_typeof(p->'jev_enabled') is distinct from 'boolean' then
  perform crm_private.fail('VALIDATION_ERROR','Expected Jev classification boolean','jev_enabled');
 end if;
 perform crm_private.validate_automation_policy_before_jev(p-'jev_enabled',owner);
end $$;
revoke all on function crm_private.validate_automation_policy(jsonb,uuid) from public,anon,authenticated;

alter table public.automation_work drop constraint automation_work_kind_check;
alter table public.automation_work add constraint automation_work_kind_check check(kind in ('discovery','revalidate','research','prepare','interview','classify'));
create function crm_private.automation_work_enabled(policy jsonb,kind text,checkpoint jsonb) returns boolean language sql immutable set search_path='' as $$
 select case when kind='classify' then coalesce(checkpoint->>'on_demand_scope'='classification',false)
 else crm_private.automation_flow_enabled(policy,kind) or coalesce(case checkpoint->>'on_demand_scope'
 when 'discovery' then kind='discovery' when 'existing' then kind in ('research','prepare','interview','revalidate') else false end,false) end;
$$;
revoke all on function crm_private.automation_work_enabled(jsonb,text,jsonb) from public,anon,authenticated;
do $upgrade$
declare definition text;old text;replacement text;begin
 definition=pg_get_functiondef('crm_private.automation_operation_before_notifications(uuid,text,jsonb)'::regprocedure);
 old=$old$ elsif op in ('automation.claim','automation.trigger') then$old$;
 replacement=$new$ elsif op in ('automation.claim','automation.trigger') then
  if input ? 'on_demand' and jsonb_typeof(input->'on_demand')<>'boolean' then perform crm_private.fail('VALIDATION_ERROR','Expected on-demand boolean');end if;
  if op='automation.trigger' and input->>'on_demand'='true' then
   if input-array['idempotency_key','profile_id','retry_failed','scope','on_demand']<>'{}' or jsonb_typeof(input->'on_demand')<>'boolean' or coalesce(input->>'scope','') not in ('discovery','existing','classification') then perform crm_private.fail('VALIDATION_ERROR','Explicit bounded manual scope required');end if;
   if p.user_id is null then perform crm_private.fail('VALIDATION_ERROR','Configure automation first');end if;
   if input ? 'profile_id' and not exists(select 1 from public.automation_profiles where user_id=owner and id=input->>'profile_id') then perform crm_private.fail('VALIDATION_ERROR','Unknown profile');end if;
   if input->>'scope'='discovery' then
    for pr in select * from public.automation_profiles where user_id=owner and (input->>'profile_id' is null or id=input->>'profile_id') for update loop
     select * into w from public.automation_work where user_id=owner and profile_id=pr.id and policy_version=p.version and kind='discovery' and state in ('queued','running','waiting') for update limit 1;
     if not found then insert into public.automation_work(user_id,profile_id,policy_version,kind,checkpoint) values(owner,pr.id,p.version,'discovery',jsonb_build_object('phase','discover','on_demand_scope','discovery')) returning * into w;
     elsif w.state<>'running' then update public.automation_work set checkpoint=checkpoint||'{"on_demand_scope":"discovery"}',next_attempt_at=now(),version=version+1 where id=w.id returning * into w;end if;
     ids=ids||jsonb_build_array(w.id);
    end loop;
   else
    for rowjob in select * from public.jobs where user_id=owner and stage in ('radar','review') order by created_at,id loop
     select * into pr from public.automation_profiles where user_id=owner and (input->>'profile_id' is null or id=input->>'profile_id') order by (resume_id=rowjob.resume_id) desc nulls last,id limit 1;
     if not found then continue;end if;
     select * into w from public.automation_work where user_id=owner and job_id=rowjob.id and policy_version=p.version and state in ('queued','running','waiting') and
       (case when input->>'scope'='classification' then kind='classify' else kind in ('research','prepare','interview') end) for update limit 1;
     if not found then
      insert into public.automation_work(user_id,profile_id,policy_version,kind,job_id,checkpoint) values(owner,pr.id,p.version,
       case when input->>'scope'='classification' then 'classify' when p.policy->'sources' ? 'exa' then 'research' else 'prepare' end,rowjob.id,
       jsonb_build_object('phase','on-demand','on_demand_scope',input->>'scope','needs_profile',input->>'scope'<>'classification' and rowjob.stage='radar' and rowjob.resume_id is distinct from pr.resume_id,'contact_only',input->>'scope'='existing' and rowjob.stage='review')) returning * into w;
     elsif w.state<>'running' then update public.automation_work set checkpoint=checkpoint||jsonb_build_object('on_demand_scope',input->>'scope'),next_attempt_at=now(),version=version+1 where id=w.id returning * into w;end if;
     ids=ids||jsonb_build_array(w.id);
    end loop;
   end if;
   result=jsonb_build_object('work_ids',ids);
  else$new$;
 if strpos(definition,old)=0 then raise exception 'Manual branch marker missing';end if;definition=replace(definition,old,replacement);
 old=$old$ elsif op='automation.heartbeat' then$old$;
 if strpos(definition,old)=0 then raise exception 'Manual branch end missing';end if;definition=replace(definition,old,$new$  end if;
 elsif op='automation.heartbeat' then$new$);
 old=$old$else array['idempotency_key','profile_id','retry_failed','scope'] end$old$;
 if strpos(definition,old)=0 then raise exception 'Trigger fields missing';end if;definition=replace(definition,old,$new$else array['idempotency_key','profile_id','retry_failed','scope','on_demand'] end$new$);
 definition=replace(definition,'crm_private.automation_flow_enabled(p.policy,kind)','crm_private.automation_work_enabled(p.policy,kind,checkpoint)');
 definition=replace(definition,'crm_private.automation_flow_enabled(p.policy,w.kind)','crm_private.automation_work_enabled(p.policy,w.kind,w.checkpoint)');
 old=$old$if (w.policy_version<>p.version or not (p.policy->>'enabled')::boolean) and jsonb_array_length(input->'children')>0$old$;
 if strpos(definition,old)=0 then raise exception 'Child fence missing';end if;definition=replace(definition,old,$new$if (w.policy_version<>p.version or not crm_private.automation_work_enabled(p.policy,w.kind,w.checkpoint)) and jsonb_array_length(input->'children')>0$new$);
 old=$old$checkpoint=input->'checkpoint',state=$old$;
 if strpos(definition,old)=0 then raise exception 'Checkpoint fence missing';end if;definition=replace(definition,old,$new$checkpoint=(input->'checkpoint'-'on_demand_scope')||case when w.checkpoint ? 'on_demand_scope' then jsonb_build_object('on_demand_scope',w.checkpoint->'on_demand_scope') else '{}'::jsonb end,state=$new$);
 definition=replace(definition,$old$crm_private.automation_flow_enabled(p.policy,x->>'kind')$old$,$new$crm_private.automation_work_enabled(p.policy,x->>'kind',w.checkpoint)$new$);
 old=$old$x->'checkpoint') on conflict(id) do nothing;$old$;
 if strpos(definition,old)=0 then raise exception 'Child metadata fence missing';end if;definition=replace(definition,old,$new$(x->'checkpoint'-'on_demand_scope')||case when w.checkpoint->>'on_demand_scope'='existing' then '{"on_demand_scope":"existing"}'::jsonb else '{}'::jsonb end) on conflict(id) do nothing;$new$);
 execute definition;
end $upgrade$;

-- A one-time grant is limited to its scope even when unrelated periodic flows are enabled.
create or replace function crm_private.automation_work_enabled(policy jsonb,kind text,checkpoint jsonb) returns boolean language sql immutable set search_path='' as $$
 select case when checkpoint ? 'on_demand_scope' then coalesce(case checkpoint->>'on_demand_scope'
 when 'classification' then kind='classify' when 'discovery' then kind='discovery'
 when 'existing' then kind in ('research','prepare','interview','revalidate') else false end,false)
 when kind='classify' then false else crm_private.automation_flow_enabled(policy,kind) end;
$$;
do $upgrade$
declare definition text;old text;begin
 definition=pg_get_functiondef('crm_private.automation_operation_before_notifications(uuid,text,jsonb)'::regprocedure);
 old=$old$  if op not in ('automation.checkpoint') and$old$;
 if strpos(definition,old)=0 then raise exception 'Classification effect fence missing';end if;definition=replace(definition,old,$new$  if w.kind='classify' and op<>'automation.checkpoint' then perform crm_private.fail('FORBIDDEN','Classification has no business or Exa effects');end if;
  if op not in ('automation.checkpoint') and$new$);
 execute definition;
end $upgrade$;

-- Bind JSON extraction before subtraction when preserving server-owned manual authorization.
do $upgrade$
declare definition text;begin
 definition=pg_get_functiondef('crm_private.automation_operation_before_notifications(uuid,text,jsonb)'::regprocedure);
 if strpos(definition,$old$input->'checkpoint'-'on_demand_scope'$old$)=0 then raise exception 'Manual checkpoint expression differs';end if;
 definition=replace(definition,$old$input->'checkpoint'-'on_demand_scope'$old$,$new$(input->'checkpoint')-'on_demand_scope'$new$);
 definition=replace(definition,$old$x->'checkpoint'-'on_demand_scope'$old$,$new$(x->'checkpoint')-'on_demand_scope'$new$);
 execute definition;
end $upgrade$;

-- Expose sanitized judgments to the owner, never request text or credentials.
do $upgrade$
declare definition text;old text;begin
 definition=pg_get_functiondef('crm_private.automation_operation_before_notifications(uuid,text,jsonb)'::regprocedure);
 old=$old$'gaps',t.checkpoint->'gaps'$old$;
 if strpos(definition,old)=0 then raise exception 'Work status summary differs';end if;
 definition=replace(definition,old,$new$'gaps',t.checkpoint->'gaps','jev',t.checkpoint->'jev'$new$);
 execute definition;
end $upgrade$;
