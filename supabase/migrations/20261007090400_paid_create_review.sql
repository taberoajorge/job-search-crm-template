-- A paid create whose response was lost stays for owner review: no policy save cancels it and no scheduler
-- path creates another paid run for that vacancy (automation-026).
create or replace function crm_private.paid_create_unresolved(owner uuid,job uuid) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.automation_work q where q.user_id=owner and q.job_id=job and q.kind in ('research','interview')
  and q.state in ('blocked','cancelled','failed') and q.checkpoint->>'provider_id' is null
  and (q.checkpoint->>'dispatching'='true' or q.error='EXA_CREATE_AMBIGUOUS'));
$$;
revoke all on function crm_private.paid_create_unresolved(uuid,uuid) from public,anon,authenticated,crm_worker;

do $$declare definition text;
 cancel_needle text=$n$state in ('queued','waiting','blocked') and not (kind in ('research','interview') and checkpoint->>'provider_id' is not null);$n$;
 radar_needle text=$n$j.stage='radar' and not exists($n$;
 contact_needle text=$n$j.stage in ('radar','review') and p.policy->'sources' ? 'exa'$n$;
 manual_needle text=$n$for rowjob in select * from public.jobs where user_id=owner and stage in ('radar','review') order by created_at,id loop$n$;
begin
 definition=pg_get_functiondef('crm_private.automation_operation_before_notifications(uuid,text,jsonb)'::regprocedure);
 if strpos(definition,'paid_create_unresolved')>0 then return;end if;
 if strpos(definition,cancel_needle)=0 or strpos(definition,radar_needle)=0 or strpos(definition,contact_needle)=0 or strpos(definition,manual_needle)=0 then raise exception 'Review automation scheduling before upgrading';end if;
 definition=replace(definition,cancel_needle,$r$state in ('queued','waiting','blocked') and not (kind in ('research','interview') and checkpoint->>'provider_id' is not null) and not (checkpoint->>'provider_id' is null and coalesce(checkpoint->>'dispatching'='true' or error='EXA_CREATE_AMBIGUOUS',false));$r$);
 definition=replace(definition,radar_needle,$r$j.stage='radar' and not crm_private.paid_create_unresolved(owner,j.id) and not exists($r$);
 definition=replace(definition,contact_needle,contact_needle||$r$ and not crm_private.paid_create_unresolved(owner,j.id)$r$);
 definition=replace(definition,manual_needle,$r$for rowjob in select * from public.jobs where user_id=owner and stage in ('radar','review') and (input->>'scope'='classification' or not crm_private.paid_create_unresolved(owner,id)) order by created_at,id loop$r$);
 execute definition;
 definition=pg_get_functiondef('crm_private.enqueue_interview(uuid,uuid,text,jsonb,boolean)'::regprocedure);
 if strpos(definition,'paid_create_unresolved')>0 then return;end if;
 if strpos(definition,E' insert into public.automation_work(user_id,profile_id,policy_version,kind,job_id,checkpoint)\n')=0 then raise exception 'Review interview enqueue before upgrading';end if;
 execute replace(definition,E' insert into public.automation_work(user_id,profile_id,policy_version,kind,job_id,checkpoint)\n',E' if crm_private.paid_create_unresolved(owner,job) then return null;end if;\n insert into public.automation_work(user_id,profile_id,policy_version,kind,job_id,checkpoint)\n');
end $$;
