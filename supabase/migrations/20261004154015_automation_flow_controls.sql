-- Keep the existing owner/receipt/notification guards and add independent flow gates.
create function crm_private.automation_flow_enabled(policy jsonb,kind text) returns boolean language sql immutable set search_path='' as $$
 select coalesce((policy->>'enabled')::boolean,false) and coalesce((policy->>case when kind='discovery' then 'discovery_enabled' else 'research_enabled' end)::boolean,true);
$$;
revoke all on function crm_private.automation_flow_enabled(jsonb,text) from public,anon,authenticated;
alter function crm_private.validate_automation_policy(jsonb,uuid) rename to validate_automation_policy_before_flows;
create function crm_private.validate_automation_policy(p jsonb,owner uuid) returns void language plpgsql set search_path='' as $$
declare k text;begin
 foreach k in array array['discovery_enabled','research_enabled'] loop
  if p ? k and jsonb_typeof(p->k) is distinct from 'boolean' then perform crm_private.fail('VALIDATION_ERROR','Expected flow boolean',k);end if;
 end loop;
 perform crm_private.validate_automation_policy_before_flows(p-array['discovery_enabled','research_enabled'],owner);
end $$;
revoke all on function crm_private.validate_automation_policy(jsonb,uuid) from public,anon,authenticated;
do $upgrade$
declare definition text;old text;replacement text;begin
 definition=pg_get_functiondef('crm_private.automation_operation_before_notifications(uuid,text,jsonb)'::regprocedure);
 old=$old$else array['idempotency_key','profile_id','retry_failed'] end$old$;replacement=$new$else array['idempotency_key','profile_id','retry_failed','scope'] end$new$;
 if strpos(definition,old)=0 then raise exception 'Flow dispatcher differs; review upgrade: %',old;end if;
 definition=replace(definition,old,replacement);
 old=$old$  if input ? 'retry_failed'$old$;replacement=$new$  if op='automation.trigger' and input ? 'scope' and coalesce(input->>'scope','') not in ('discovery','existing','all') then perform crm_private.fail('VALIDATION_ERROR','Invalid flow scope');end if;
  if op='automation.trigger' and input->>'scope' in ('discovery','existing') and not crm_private.automation_flow_enabled(p.policy,case input->>'scope' when 'discovery' then 'discovery' else 'research' end) then perform crm_private.fail('FORBIDDEN','Requested flow is paused');end if;
  if input ? 'retry_failed'$new$;
 if strpos(definition,old)=0 then raise exception 'Flow dispatcher differs; review upgrade: %',old;end if;
 definition=replace(definition,old,replacement);
 old=$old$and kind in ('prepare','interview','discovery') and state$old$;replacement=$new$and kind in ('prepare','interview','discovery') and crm_private.automation_flow_enabled(p.policy,kind) and (coalesce(input->>'scope','all')='all' or (input->>'scope'='discovery')=(kind='discovery')) and state$new$;
 if strpos(definition,old)=0 then raise exception 'Flow dispatcher differs; review upgrade: %',old;end if;
 definition=replace(definition,old,replacement);
 old=$old$where user_id=owner and (next_due_at<=now() or op='automation.trigger')$old$;replacement=$new$where user_id=owner and crm_private.automation_flow_enabled(p.policy,'discovery') and coalesce(input->>'scope','all')<>'existing' and (next_due_at<=now() or op='automation.trigger')$new$;
 if strpos(definition,old)=0 then raise exception 'Flow dispatcher differs; review upgrade: %',old;end if;
 definition=replace(definition,old,replacement);
 old=$old$   -- Refresh preparations for actual upcoming interviews$old$;replacement=$new$   if crm_private.automation_flow_enabled(p.policy,'research') and coalesce(input->>'scope','all')<>'discovery' then
   -- Refresh preparations for actual upcoming interviews$new$;
 if strpos(definition,old)=0 then raise exception 'Flow dispatcher differs; review upgrade: %',old;end if;
 definition=replace(definition,old,replacement);
 old=$old$   end loop;
  end if;
  if op='automation.trigger' then result=jsonb_build_object('work_ids',ids);$old$;replacement=$new$   end loop;
   end if;
  end if;
  if op='automation.trigger' then result=jsonb_build_object('work_ids',case when input->>'scope'='existing' then coalesce((select jsonb_agg(q.id) from public.automation_work q where q.user_id=owner and q.policy_version=p.version and q.state='queued' and crm_private.automation_flow_enabled(p.policy,q.kind) and (coalesce(input->>'scope','all')='all' or (input->>'scope'='discovery')=(q.kind='discovery'))),'[]'::jsonb) else ids end);$new$;
 if strpos(definition,old)=0 then raise exception 'Flow dispatcher differs; review upgrade: %',old;end if;
 definition=replace(definition,old,replacement);
 old=$old$policy_version=p.version and (p.policy->>'enabled')::boolean or kind='research'$old$;replacement=$new$policy_version=p.version and crm_private.automation_flow_enabled(p.policy,kind) or kind='research'$new$;
 if strpos(definition,old)=0 then raise exception 'Flow dispatcher differs; review upgrade: %',old;end if;
 definition=replace(definition,old,replacement);
 old=$old$if op not in ('automation.checkpoint') and (w.policy_version<>p.version or not (p.policy->>'enabled')::boolean)$old$;replacement=$new$if op not in ('automation.checkpoint') and (w.policy_version<>p.version or not crm_private.automation_flow_enabled(p.policy,w.kind))$new$;
 if strpos(definition,old)=0 then raise exception 'Flow dispatcher differs; review upgrade: %',old;end if;
 definition=replace(definition,old,replacement);
 old=$old$    if not exists(select 1 from public.automation_profiles where user_id=owner and id=coalesce(x->>'profile_id',w.profile_id))$old$;replacement=$new$    if not crm_private.automation_flow_enabled(p.policy,x->>'kind') then continue;end if;
    if not exists(select 1 from public.automation_profiles where user_id=owner and id=coalesce(x->>'profile_id',w.profile_id))$new$;
 if strpos(definition,old)=0 then raise exception 'Flow dispatcher differs; review upgrade: %',old;end if;
 definition=replace(definition,old,replacement);
 execute definition;
end $upgrade$;
