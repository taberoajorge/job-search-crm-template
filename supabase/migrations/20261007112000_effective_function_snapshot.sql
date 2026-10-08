-- Effective source of every function whose body earlier migrations assembled through pg_get_functiondef text patches.
-- Generated from a replay of all previous migrations; applying it changes no definition, security mode or grant
-- (verified by hashing pg_get_functiondef, ACLs and prosecdef before and after on PostgreSQL 16 and the Supabase 17 stack).
-- Change these functions with create or replace from this text instead of adding another text patch.

CREATE OR REPLACE FUNCTION crm_private.automation_operation_before_notifications(owner uuid, op text, input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
#variable_conflict use_variable
declare p public.automation_policies;w public.automation_work;pr public.automation_profiles;receipt public.mutation_receipts;
 key uuid;hash text;result jsonb;r jsonb;ids jsonb='[]';x jsonb;v bigint;amount numeric;daily numeric;monthly numeric;oldjob jsonb;rowjob public.jobs;resume public.resumes;company public.companies;pk public.automation_packs;stale boolean;
begin
 if owner is null or owner is distinct from auth.uid() or not crm_private.is_owner() then perform crm_private.fail('FORBIDDEN','Live owner session required');end if;
 if jsonb_typeof(input)<>'object' or octet_length(input::text)>1048576 then perform crm_private.fail('VALIDATION_ERROR','Expected bounded object');end if;
 if op not in ('automation.status','automation.configure','automation.trigger','automation.claim','automation.checkpoint','automation.heartbeat','automation.reserve','automation.commit','automation.pack.get','automation.pack.save') then perform crm_private.fail('VALIDATION_ERROR','Unknown automation operation');end if;
 -- Serialize owner schedule/policy/reservations and effects, never a long provider wait.
 perform pg_advisory_xact_lock(hashtextextended(owner::text,0));
 select * into p from public.automation_policies where user_id=owner for update;
 if op='automation.status' then
  if input<>'{}' then perform crm_private.fail('VALIDATION_ERROR','Status takes no input');end if;
  return jsonb_build_object('policy',p.policy,'policy_version',coalesce(p.version,0),'server_time',now(),'heartbeat_at',p.heartbeat_at,'executor_status',p.executor_status,'executor_stale',p.heartbeat_at is null or p.heartbeat_at<now()-interval '3 minutes',
   'profiles',coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.automation_profiles t where user_id=owner),'[]'::jsonb),
   'work',coalesce((select jsonb_agg(to_jsonb(t)-'checkpoint'||jsonb_build_object('checkpoint',jsonb_build_object('phase',t.checkpoint->'phase','counts',t.checkpoint->'counts','gaps',t.checkpoint->'gaps','jev',(t.checkpoint->'jev')-'criteria')) order by t.created_at desc) from (select * from public.automation_work where user_id=owner order by created_at desc limit 50) t),'[]'::jsonb),
   'spend',jsonb_build_object('daily',coalesce((select sum(coalesce(reported_usd,reserved_usd)) from public.automation_reservations where user_id=owner and created_at>=date_trunc('day',now() at time zone coalesce(p.policy->>'timezone','UTC')) at time zone coalesce(p.policy->>'timezone','UTC')),0), 'monthly',coalesce((select sum(coalesce(reported_usd,reserved_usd)) from public.automation_reservations where user_id=owner and created_at>=date_trunc('month',now() at time zone coalesce(p.policy->>'timezone','UTC')) at time zone coalesce(p.policy->>'timezone','UTC')),0)));
 end if;
 if op='automation.pack.get' then
  if not input ? 'job_id' or input-array['job_id']<>'{}' then perform crm_private.fail('VALIDATION_ERROR','Job required');end if;
  select * into pk from public.automation_packs where user_id=owner and job_id=(input->>'job_id')::uuid order by version desc limit 1;
  if not found then return jsonb_build_object('pack',null,'stale',false);end if;
  select * into rowjob from public.jobs where user_id=owner and id=pk.job_id;
  select * into resume from public.resumes where user_id=owner and id=pk.resume_id;
  select * into company from public.companies where user_id=owner and id=rowjob.company_id;
  stale=pk.job_version<>rowjob.version or pk.resume_version<>resume.version or not resume.active or pk.company_version<>company.version;
  return jsonb_build_object('pack',to_jsonb(pk),'stale',stale);
 end if;
 perform crm_private.required(input,array['idempotency_key']);key=(input->>'idempotency_key')::uuid;
 hash=encode(extensions.digest(op||input::text,'sha256'),'hex');
 select * into receipt from public.mutation_receipts where user_id=owner and idempotency_key=key;
 if found then if receipt.operation<>op or receipt.payload_hash<>hash then perform crm_private.fail('IDEMPOTENCY_CONFLICT','Changed request identity');end if;return receipt.response;end if;
 if op='automation.configure' then
  if input-array['policy','expected_version','idempotency_key']<>'{}' or jsonb_typeof(input->'expected_version')<>'number' or (input->>'expected_version') !~ '^\d+$' then perform crm_private.fail('VALIDATION_ERROR','Guarded policy input required');end if;
  if coalesce(p.version,0)<>(input->>'expected_version')::bigint then perform crm_private.fail('CONFLICT','Policy changed','expected_version',coalesce(p.version,0));end if;
  perform crm_private.validate_automation_policy(input->'policy',owner);
  insert into public.automation_policies(user_id,policy) values(owner,input->'policy') on conflict(user_id) do update set policy=excluded.policy,version=automation_policies.version+1,updated_at=now() returning * into p;
  for x in select value from jsonb_array_elements(p.policy->'profiles') loop
   insert into public.automation_profiles(user_id,id,resume_id,criteria) values(owner,x->>'id',(x->>'resume_id')::uuid,x) on conflict(user_id,id) do update set resume_id=excluded.resume_id,criteria=excluded.criteria;
  end loop;
  delete from public.automation_profiles where user_id=owner and not exists(select 1 from jsonb_array_elements(p.policy->'profiles') as entries(value) where entries.value->>'id'=automation_profiles.id);
  update public.automation_work set state='cancelled',updated_at=now(),version=version+1 where user_id=owner and policy_version<>p.version and state in ('queued','waiting','blocked') and not (kind in ('research','interview') and checkpoint->>'provider_id' is not null) and not (checkpoint->>'provider_id' is null and coalesce(checkpoint->>'dispatching'='true' or error='EXA_CREATE_AMBIGUOUS',false));
  if not (p.policy->>'digest_email')::boolean then update crm_private.automation_emails set state='cancelled' where user_id=owner and kind='digest' and state='queued';end if;
  if not (p.policy->>'closure_email')::boolean then update crm_private.automation_emails set state='cancelled' where user_id=owner and kind='closed' and state='queued';end if;
  result=jsonb_build_object('version',p.version,'policy',p.policy);
 elsif op in ('automation.claim','automation.trigger') then
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
    for rowjob in select * from public.jobs where user_id=owner and stage in ('radar','review') and (input->>'scope'='classification' or not crm_private.paid_create_unresolved(owner,id)) order by created_at,id loop
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
  else
  if p.user_id is null then perform crm_private.fail('VALIDATION_ERROR','Configure automation first');end if;
  if input-(case when op='automation.claim' then array['idempotency_key','executor_id','content_version'] else array['idempotency_key','profile_id','retry_failed','scope','on_demand'] end)<>'{}' then perform crm_private.fail('VALIDATION_ERROR','Unknown trigger/claim input');end if;

  if op='automation.trigger' and input ? 'scope' and coalesce(input->>'scope','') not in ('discovery','existing','all') then perform crm_private.fail('VALIDATION_ERROR','Invalid flow scope');end if;
  if op='automation.trigger' and input->>'scope' in ('discovery','existing') and not crm_private.automation_flow_enabled(p.policy,case input->>'scope' when 'discovery' then 'discovery' else 'research' end) then perform crm_private.fail('FORBIDDEN','Requested flow is paused');end if;
  if input ? 'retry_failed' and jsonb_typeof(input->'retry_failed')<>'boolean' then perform crm_private.fail('VALIDATION_ERROR','Expected retry boolean');end if;
  if op='automation.trigger' and input->'retry_failed'='true'::jsonb and (p.policy->>'enabled')::boolean then
   update public.automation_work set state='queued',attempts=0,error=null,version=version+1,next_attempt_at=now(),updated_at=now()
   where user_id=owner and policy_version=p.version and kind in ('prepare','interview','discovery') and crm_private.automation_work_enabled(p.policy,kind,checkpoint) and (coalesce(input->>'scope','all')='all' or (input->>'scope'='discovery')=(kind='discovery')) and state in ('waiting','blocked','failed') and error in ('RETRY_LIMIT','MODEL_INTERRUPTED','MODEL_SCHEMA_INVALID');
  end if;
  if op='automation.trigger' and not (p.policy->>'enabled')::boolean then perform crm_private.fail('FORBIDDEN','Automation is paused');end if;
  if (p.policy->>'enabled')::boolean then
   for pr in select * from public.automation_profiles where user_id=owner and crm_private.automation_flow_enabled(p.policy,'discovery') and coalesce(input->>'scope','all')<>'existing' and (next_due_at<=now() or op='automation.trigger') and (input->>'profile_id' is null or id=input->>'profile_id') for update loop
    select * into w from public.automation_work where user_id=owner and profile_id=pr.id and kind='discovery' and state in ('queued','running','waiting') limit 1;
    if not found then insert into public.automation_work(user_id,profile_id,policy_version,kind,checkpoint) values(owner,pr.id,p.version,'discovery',jsonb_build_object('phase','discover','profile',pr.criteria)) returning * into w;end if;
    ids=ids||jsonb_build_array(w.id);
    update public.automation_profiles set next_due_at=now()+make_interval(hours=>(p.policy->>'interval_hours')::int) where user_id=owner and id=pr.id;
   end loop;
   if crm_private.automation_flow_enabled(p.policy,'research') and coalesce(input->>'scope','all')<>'discovery' then
   -- Refresh preparations for actual upcoming interviews before bulk radar work.
   for rowjob in select distinct j.* from public.jobs j join public.interviews i on i.user_id=j.user_id and i.job_id=j.id where j.user_id=owner and i.state='planned' and false and i.scheduled_at>=now() and not exists(select 1 from public.automation_work q where q.user_id=owner and q.job_id=j.id and q.kind='interview' and q.state in ('queued','running','waiting','blocked')) and not exists(select 1 from public.automation_packs k where k.user_id=owner and k.job_id=j.id and k.job_version=j.version and k.resume_id=j.resume_id and k.created_at>now()-interval '24 hours') loop
    select * into pr from public.automation_profiles where user_id=owner order by (resume_id=rowjob.resume_id) desc nulls last,id limit 1;
    if found then insert into public.automation_work(user_id,profile_id,policy_version,kind,job_id,checkpoint) values(owner,pr.id,p.version,'interview',rowjob.id,jsonb_build_object('phase','interview-refresh','needs_profile',rowjob.resume_id is distinct from pr.resume_id));end if;
   end loop;
   -- Existing radar is first-class work, including legacy jobs without a CV mapping.
   for rowjob in select * from public.jobs j where j.user_id=owner and j.stage='radar' and not crm_private.paid_create_unresolved(owner,j.id) and not exists(select 1 from public.automation_work q where q.user_id=owner and q.job_id=j.id and q.kind in ('research','prepare','interview') and (q.state in ('queued','running','waiting','blocked','failed') or q.state='completed' and q.checkpoint->>'phase'='finished')) order by j.created_at,j.id loop
    select * into pr from public.automation_profiles where user_id=owner order by (resume_id=rowjob.resume_id) desc nulls last,id limit 1;
    if found then
     insert into public.automation_work(user_id,profile_id,policy_version,kind,job_id,checkpoint) values(owner,pr.id,p.version,case when rowjob.resume_id=pr.resume_id and rowjob.posting_url is not null and p.policy->'sources' ? 'exa' then 'research' else 'prepare' end,rowjob.id,jsonb_build_object('phase','radar-backlog','needs_profile',rowjob.resume_id is distinct from pr.resume_id));
    end if;
   end loop;

   for rowjob in select j.* from public.jobs j where j.user_id=owner and j.stage in ('radar','review') and p.policy->'sources' ? 'exa' and not crm_private.paid_create_unresolved(owner,j.id)
    and not exists(select 1 from public.contacts c where c.user_id=owner and c.job_id=j.id and c.linkedin_url is not null)
    and not exists(select 1 from public.automation_work q where q.user_id=owner and q.job_id=j.id and q.kind in ('research','prepare','interview') and q.state in ('queued','running','waiting'))
    and not exists(select 1 from public.automation_work q where q.user_id=owner and q.job_id=j.id and q.checkpoint->>'contact_only'='true' and (q.created_at>now()-interval '24 hours' or q.state='completed' and q.checkpoint->>'contact_job_version'=j.version::text))
    order by j.created_at,j.id loop
    select * into pr from public.automation_profiles where user_id=owner order by (resume_id=rowjob.resume_id) desc nulls last,id limit 1;
    if found then insert into public.automation_work(user_id,profile_id,policy_version,kind,job_id,checkpoint)
     values(owner,pr.id,p.version,'research',rowjob.id,jsonb_build_object('phase','contact-backlog','contact_only',true,'contact_job_version',rowjob.version));end if;
   end loop;
   for pr in select * from public.automation_profiles where user_id=owner and next_revalidation_at<=now() for update loop
    if not exists(select 1 from public.automation_work where user_id=owner and profile_id=pr.id and kind='revalidate' and state in ('queued','running','waiting')) then
     insert into public.automation_work(user_id,profile_id,policy_version,kind,checkpoint) values(owner,pr.id,p.version,'revalidate',jsonb_build_object('phase','revalidate','profile',pr.criteria));
    end if;
    update public.automation_profiles set next_revalidation_at=now()+make_interval(hours=>(p.policy->>'revalidate_hours')::int) where user_id=owner and id=pr.id;
   end loop;
   end if;
  end if;
  if op='automation.trigger' then result=jsonb_build_object('work_ids',case when input->>'scope'='existing' then coalesce((select jsonb_agg(q.id) from public.automation_work q where q.user_id=owner and q.policy_version=p.version and q.state='queued' and crm_private.automation_flow_enabled(p.policy,q.kind) and (coalesce(input->>'scope','all')='all' or (input->>'scope'='discovery')=(q.kind='discovery'))),'[]'::jsonb) else ids end);
  else
   if exists(select 1 from public.automation_work where user_id=owner and state='running' and lease_until>now()) then result=jsonb_build_object('work',null);
   else
    update public.automation_work set state='failed',error='RETRY_LIMIT',lease_token=null,lease_until=null,version=version+1,updated_at=now() where user_id=owner and attempts>=3 and (state='waiting' or state='running' and lease_until<now()) and checkpoint->>'provider_id' is null and checkpoint->>'phase' is distinct from 'budget-wait';
    select * into w from public.automation_work where user_id=owner and next_attempt_at<=now() and (checkpoint->>'content_version' is distinct from '2' or input->>'content_version'='2') and ((state in ('queued','waiting') or (state='running' and lease_until<now())) and (policy_version=p.version and crm_private.automation_work_enabled(p.policy,kind,checkpoint) or kind in ('research','interview') and checkpoint->>'provider_id' is not null)) order by case kind when 'interview' then 0 when 'research' then 1 when 'prepare' then case when checkpoint->>'needs_profile'='true' then 3 else 2 end when 'discovery' then 4 else 5 end,next_attempt_at,id for update skip locked limit 1;
    if not found then result=jsonb_build_object('work',null);
    else update public.automation_work set state='running',lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes',executor_id=(input->>'executor_id')::uuid,attempts=attempts+1,version=version+1,updated_at=now() where id=w.id returning * into w;result=jsonb_build_object('work',to_jsonb(w));end if;
   end if;
  end if;
  end if;
 elsif op='automation.heartbeat' then
  if input-array['idempotency_key','executor_id','status','work_id','lease_token']<>'{}' or input->>'status' not in ('online','auth_required','provider_error','budget_blocked') then perform crm_private.fail('VALIDATION_ERROR','Invalid heartbeat');end if;
  update public.automation_policies set heartbeat_at=now(),executor_id=(input->>'executor_id')::uuid,executor_status=input->>'status' where user_id=owner;
  if input ? 'work_id' then update public.automation_work set lease_until=now()+interval '5 minutes' where user_id=owner and id=(input->>'work_id')::uuid and state='running' and lease_token=(input->>'lease_token')::uuid and lease_until>now() and executor_id=(input->>'executor_id')::uuid;if not found then perform crm_private.fail('FORBIDDEN','Expired lease');end if;end if;
  result=jsonb_build_object('server_time',now());
 else
  select * into w from public.automation_work where user_id=owner and id=(input->>'work_id')::uuid for update;
  if not found or w.state<>'running' or w.lease_token is distinct from (input->>'lease_token')::uuid or w.lease_until<=now() then perform crm_private.fail('FORBIDDEN','Valid work lease required');end if;
  if w.version<>(input->>'expected_version')::bigint then perform crm_private.fail('CONFLICT','Work changed','expected_version',w.version);end if;
  if w.kind='classify' and op<>'automation.checkpoint' then perform crm_private.fail('FORBIDDEN','Classification has no business or Exa effects');end if;
  if op not in ('automation.checkpoint') and (w.policy_version<>p.version or not crm_private.automation_work_enabled(p.policy,w.kind,w.checkpoint)) then perform crm_private.fail('FORBIDDEN','Policy paused or changed');end if;
  if op='automation.checkpoint' then
   if input-array['idempotency_key','work_id','lease_token','expected_version','state','checkpoint','next_attempt_at','error','children']<>'{}' or input->>'state' not in ('running','waiting','completed','failed','blocked','cancelled') or jsonb_typeof(input->'checkpoint')<>'object' or jsonb_typeof(input->'children')<>'array' or jsonb_array_length(input->'children')>20 then perform crm_private.fail('VALIDATION_ERROR','Invalid checkpoint');end if;
   if (w.policy_version<>p.version or not crm_private.automation_work_enabled(p.policy,w.kind,w.checkpoint)) and jsonb_array_length(input->'children')>0 then perform crm_private.fail('FORBIDDEN','Changed policy cannot create work');end if;
   if input->'checkpoint' ? 'reported_usd' then
    amount=(input->'checkpoint'->>'reported_usd')::numeric;if amount<0 then perform crm_private.fail('VALIDATION_ERROR','Invalid reported cost');end if;
    update public.automation_reservations set reported_usd=amount where user_id=owner and work_id=w.id and id=(input->'checkpoint'->>'request_id')::uuid;
   end if;
   update public.automation_work set checkpoint=((input->'checkpoint')-'on_demand_scope')||case when w.checkpoint ? 'on_demand_scope' then jsonb_build_object('on_demand_scope',w.checkpoint->'on_demand_scope') else '{}'::jsonb end,state=input->>'state',error=input->>'error',next_attempt_at=coalesce((input->>'next_attempt_at')::timestamptz,now()),version=version+1,updated_at=now(),lease_token=case when input->>'state'='running' then lease_token end,lease_until=case when input->>'state'='running' then lease_until end where id=w.id returning * into w;
   for x in select value from jsonb_array_elements(input->'children') loop
    if x->>'kind' not in ('discovery','revalidate','research','prepare','interview') or jsonb_typeof(x->'checkpoint')<>'object' then perform crm_private.fail('VALIDATION_ERROR','Invalid child');end if;
    if not crm_private.automation_work_enabled(p.policy,x->>'kind',w.checkpoint) then continue;end if;
    if not exists(select 1 from public.automation_profiles where user_id=owner and id=coalesce(x->>'profile_id',w.profile_id)) then perform crm_private.fail('FORBIDDEN','Unknown child profile');end if;
    if exists(select 1 from public.automation_work where id=(x->>'id')::uuid and (user_id<>owner or job_id is distinct from (x->>'job_id')::uuid or profile_id<>coalesce(x->>'profile_id',w.profile_id))) then perform crm_private.fail('IDEMPOTENCY_CONFLICT','Child identity differs');end if;
    insert into public.automation_work(id,user_id,profile_id,policy_version,kind,job_id,checkpoint) values((x->>'id')::uuid,owner,coalesce(x->>'profile_id',w.profile_id),p.version,x->>'kind',(x->>'job_id')::uuid,((x->'checkpoint')-'on_demand_scope')||case when w.checkpoint->>'on_demand_scope'='existing' then '{"on_demand_scope":"existing"}'::jsonb else '{}'::jsonb end) on conflict(id) do nothing;
   end loop;
   result=jsonb_build_object('work',to_jsonb(w));
  elsif op='automation.reserve' then
   if input-array['idempotency_key','work_id','lease_token','expected_version','request_id','amount_usd']<>'{}' or jsonb_typeof(input->'amount_usd')<>'number' then perform crm_private.fail('VALIDATION_ERROR','Invalid reservation');end if;
   amount=(input->>'amount_usd')::numeric;
   select coalesce(sum(coalesce(reported_usd,reserved_usd)),0) into daily from public.automation_reservations where user_id=owner and created_at>=date_trunc('day',now() at time zone (p.policy->>'timezone')) at time zone (p.policy->>'timezone');
   select coalesce(sum(coalesce(reported_usd,reserved_usd)),0) into monthly from public.automation_reservations where user_id=owner and created_at>=date_trunc('month',now() at time zone (p.policy->>'timezone')) at time zone (p.policy->>'timezone');
   if not p.policy->'sources' ? 'exa' or amount<=0 or amount>(p.policy->>'exa_per_run_usd')::numeric or daily+amount>(p.policy->>'exa_daily_usd')::numeric or monthly+amount>(p.policy->>'exa_monthly_usd')::numeric then perform crm_private.fail('FORBIDDEN','Research budget exhausted');end if;
   insert into public.automation_reservations(id,user_id,work_id,reserved_usd) values((input->>'request_id')::uuid,owner,w.id,amount);
   result=jsonb_build_object('request_id',input->>'request_id','reserved_usd',amount);
  elsif op='automation.commit' then
   if input-array['idempotency_key','work_id','lease_token','expected_version','operation','input']<>'{}' or input->>'operation' not in ('companies.upsert','sources.upsert','jobs.upsert','jobs.transition','contacts.upsert','outreach.draft','verifications.record') then perform crm_private.fail('FORBIDDEN','Unapproved automation effect');end if;
   if input->>'operation'='jobs.upsert' and ((input->'input' ? 'applied_at' and input->'input'->'applied_at'<>'null'::jsonb) or (input->'input' ? 'stage' and input->'input'->>'stage' not in ('radar','review','ready'))) then perform crm_private.fail('FORBIDDEN','No inferred applications or closures');end if;
   if input->>'operation'='contacts.upsert' and input->'input' ? 'status' and input->'input'->>'status'<>'uncontacted' then perform crm_private.fail('FORBIDDEN','No inferred contact events');end if;
   if input->>'operation'='jobs.transition' then
    select to_jsonb(j) into oldjob from public.jobs j where user_id=owner and id=(input->'input'->>'id')::uuid for update;
    if oldjob->>'applied_at' is not null or oldjob->>'stage' not in ('radar','review','ready') or input->'input'->>'stage' not in ('review','ready','archived') then perform crm_private.fail('FORBIDDEN','Protected process cannot be changed by automation');end if;
    if input->'input'->>'stage'='archived' and not exists(select 1 from public.verifications where user_id=owner and job_id=(oldjob->>'id')::uuid and status='closed' and evidence_url is not null and checked_at>now()-interval '24 hours') then perform crm_private.fail('FORBIDDEN','Verified current closure required');end if;
   end if;
   if input->>'operation'='jobs.upsert' and input->'input' ? 'id' then select to_jsonb(j) into oldjob from public.jobs j where user_id=owner and id=(input->'input'->>'id')::uuid for update; if input->'input' ? 'stage' and oldjob->>'stage' not in ('radar','review','ready') then perform crm_private.fail('FORBIDDEN','Protect application stage');end if;end if;
   r=crm_private.operation(owner,input->>'operation',input->'input');if jsonb_typeof(r->'error')='object' then perform crm_private.fail(r->'error'->>'code',r->'error'->>'message',r->'error'->>'field',(r->'error'->>'current_version')::bigint);end if;
   if input->>'operation'='jobs.transition' and input->'input'->>'stage'='archived' then
   end if;
   result=jsonb_build_object('result',r);
  elsif op='automation.pack.save' then
   if input-array['idempotency_key','work_id','lease_token','expected_version','job_id','resume_id','job_version','resume_version','company_version','expected_pack_version','content','model','effort']<>'{}' then perform crm_private.fail('VALIDATION_ERROR','Unknown pack fields');end if;
   if w.kind not in ('prepare','interview') or w.job_id is distinct from (input->>'job_id')::uuid then perform crm_private.fail('FORBIDDEN','Pack belongs to claimed preparation');end if;
   select * into rowjob from public.jobs where user_id=owner and id=(input->>'job_id')::uuid;
   select * into resume from public.resumes where user_id=owner and id=(input->>'resume_id')::uuid and active;
   select * into company from public.companies where user_id=owner and id=rowjob.company_id;
   if rowjob.id is null or resume.id is null or rowjob.version<>(input->>'job_version')::bigint or resume.version<>(input->>'resume_version')::bigint then perform crm_private.fail('CONFLICT','Pack inputs changed');end if;

   if input->>'company_version' is null or company.version<>(input->>'company_version')::bigint then perform crm_private.fail('CONFLICT','Company facts changed');end if;
   select coalesce(max(version),0) into v from public.automation_packs where user_id=owner and job_id=rowjob.id;
   if v<>(input->>'expected_pack_version')::bigint then perform crm_private.fail('CONFLICT','Pack changed','expected_pack_version',v);end if;
   if input->'content'->'predictions' is distinct from 'true'::jsonb or input->'content'->'practice_completed' is distinct from 'false'::jsonb or jsonb_typeof(input->'content'->'questions')<>'array' or jsonb_array_length(input->'content'->'questions') not between 3 and 12 then perform crm_private.fail('VALIDATION_ERROR','Pack must contain predicted bilingual questions, not completed events');end if;
   perform crm_private.validate_automation_pack(input->'content');
   if input->>'effort' not in ('low','medium','high') or length(input->>'model') not between 1 and 100 then perform crm_private.fail('VALIDATION_ERROR','Invalid model/effort');end if;
   insert into public.automation_packs(user_id,job_id,resume_id,version,job_version,resume_version,company_version,content,model,effort) values(owner,rowjob.id,resume.id,v+1,rowjob.version,resume.version,company.version,input->'content',input->>'model',input->>'effort') returning * into pk;
   result=jsonb_build_object('pack',to_jsonb(pk),'stale',false);
  end if;
 end if;
 insert into public.mutation_receipts(user_id,idempotency_key,operation,payload_hash,response) values(owner,key,op,hash,result);
 return result;
exception when sqlstate 'CR001' then return jsonb_build_object('error',SQLERRM::jsonb);
 when unique_violation then return jsonb_build_object('error',jsonb_build_object('code','CONFLICT','message','Work or request identity already exists','retryable',false));
 when invalid_text_representation or check_violation or not_null_violation or foreign_key_violation or numeric_value_out_of_range then return jsonb_build_object('error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid automation input','retryable',false));
end $function$
;

CREATE OR REPLACE FUNCTION crm_private.automation_operation(owner uuid, op text, input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare p public.automation_policies;w public.automation_work;g public.automation_company_guides;c public.companies;i public.automation_interview_intents;
 r jsonb;receipt public.mutation_receipts;hash text;key uuid;v bigint;request_work_id uuid;x jsonb;begin
 if owner is null or owner is distinct from auth.uid() or not crm_private.is_owner() then perform crm_private.fail('FORBIDDEN','Live owner session required');end if;
 if jsonb_typeof(input) is distinct from 'object' or octet_length(input::text)>1048576 then perform crm_private.fail('VALIDATION_ERROR','Expected bounded object');end if;
 perform pg_advisory_xact_lock(hashtextextended(owner::text,0));
 if op='automation.claim' then
  if input ? 'content_version' and input->'content_version' is distinct from '2'::jsonb then perform crm_private.fail('VALIDATION_ERROR','Unsupported worker content version');end if;
  if not exists(select 1 from public.mutation_receipts where user_id=owner and idempotency_key=(input->>'idempotency_key')::uuid) then
  for i in select * from public.automation_interview_intents where user_id=owner and active loop perform crm_private.enqueue_interview(owner,i.job_id,i.origin);end loop;
  end if;
 end if;
 if op='automation.company-guide.get' then
  perform crm_private.validate(input,array['company_id']);perform crm_private.required(input,array['company_id']);
  select * into c from public.companies where user_id=owner and id=(input->>'company_id')::uuid;if not found then perform crm_private.fail('NOT_FOUND','Company not found');end if;
  select * into g from public.automation_company_guides where user_id=owner and company_id=c.id order by version desc limit 1;
  return jsonb_build_object('guide',case when g.id is not null then to_jsonb(g) end,'stale',g.id is not null and g.company_version<>c.version);
 end if;
 if op='automation.pack.get' then
  r=crm_private.automation_operation_before_understanding(owner,op,input);if r ? 'error' then return r;end if;
  select * into i from public.automation_interview_intents where user_id=owner and job_id=(input->>'job_id')::uuid;
  select * into p from public.automation_policies where user_id=owner;
  select * into w from public.automation_work where user_id=owner and job_id=(input->>'job_id')::uuid and kind='interview' order by created_at desc,id desc limit 1;
  return r||jsonb_build_object('stale',coalesce((r->>'stale')::boolean,false) or coalesce((r->'pack'->'content'->>'content_version'='2' and (select max(version) from public.automation_company_guides where user_id=owner and company_id=(select company_id from public.jobs where user_id=owner and id=(input->>'job_id')::uuid)) is distinct from (r->'pack'->'content'->>'guide_version')::bigint),false) or coalesce((r->'pack'->'content'->>'depth'='interview' and i.revision is distinct from r->'pack'->'content'->>'context_revision'),false),
   'preparation',case when w.id is not null or i.job_id is not null then jsonb_build_object('state',coalesce(w.state,'queued'),'phase',w.checkpoint->>'phase','error',w.error,'updated_at',coalesce(w.updated_at,i.requested_at),'paused',not coalesce(crm_private.automation_work_enabled(p.policy,w.kind,w.checkpoint),false),'active',coalesce(i.active,true),'context_revision',coalesce(i.revision,''),'preparation_context',coalesce(i.preparation_context,'[]'),'rounds',crm_private.interview_context(owner,(input->>'job_id')::uuid)) end);
 end if;
 if op='automation.trigger' and coalesce(input->>'scope','')<>'interview' and input ?| array['job_id','interview_id','preparation_context'] then perform crm_private.fail('VALIDATION_ERROR','Interview fields require interview scope');end if;
 if op='automation.company-guide.save' or (op='automation.trigger' and input->>'scope'='interview') then
  key=(input->>'idempotency_key')::uuid;if key is null then perform crm_private.fail('VALIDATION_ERROR','Idempotency key required');end if;
  hash=encode(extensions.digest(op||input::text,'sha256'),'hex');
  select * into receipt from public.mutation_receipts where user_id=owner and idempotency_key=key;
  if found then if receipt.operation<>op or receipt.payload_hash<>hash then perform crm_private.fail('IDEMPOTENCY_CONFLICT','Changed request identity');end if;return receipt.response;end if;
  select * into p from public.automation_policies where user_id=owner;
  if op='automation.trigger' then
   if input-array['idempotency_key','scope','job_id','interview_id','preparation_context','on_demand']<>'{}' or not input ? 'job_id' then perform crm_private.fail('VALIDATION_ERROR','Vacancy-specific preparation required');end if;
   perform crm_private.validate(input-array['preparation_context','on_demand'],array['idempotency_key','scope','job_id','interview_id']);
   if input ? 'on_demand' and jsonb_typeof(input->'on_demand')<>'boolean' then perform crm_private.fail('VALIDATION_ERROR','Expected on-demand boolean');end if;
   if input ? 'interview_id' and not exists(select 1 from public.interviews where user_id=owner and id=(input->>'interview_id')::uuid and job_id=(input->>'job_id')::uuid and state='planned') then perform crm_private.fail('FORBIDDEN','Owned planned round required');end if;
   if input ? 'preparation_context' then
    if jsonb_typeof(input->'preparation_context') is distinct from 'array' or jsonb_array_length(input->'preparation_context')>20 then perform crm_private.fail('VALIDATION_ERROR','Bounded confirmed context required');end if;
    for x in select value from jsonb_array_elements(input->'preparation_context') loop
     if jsonb_typeof(x) is distinct from 'object' or not x ?& array['topic','fact','confirmed'] or x-array['topic','fact','confirmed']<>'{}' or x->'confirmed' is distinct from 'true'::jsonb
      or coalesce(x->>'topic','') not in ('english_level','departure','career_goals','experience','interests') or jsonb_typeof(x->'fact') is distinct from 'string' or length(trim(x->>'fact')) not between 1 and (case when x->>'topic'='english_level' then 200 else 3000 end) then perform crm_private.fail('VALIDATION_ERROR','Unconfirmed private fact');end if;
    end loop;
   end if;
   request_work_id=crm_private.enqueue_interview(owner,(input->>'job_id')::uuid,'explicit',input->'preparation_context',coalesce(input->>'on_demand'='true',false));
   r=jsonb_build_object('work_ids',case when request_work_id is null then '[]'::jsonb else jsonb_build_array(request_work_id) end);
  else
   if input-array['idempotency_key','work_id','lease_token','expected_version','company_id','company_version','expected_guide_version','content','source_fingerprint']<>'{}' then perform crm_private.fail('VALIDATION_ERROR','Unknown guide input');end if;
   select * into w from public.automation_work where user_id=owner and id=(input->>'work_id')::uuid for update;
   if w.id is null or w.state<>'running' or w.lease_token is distinct from (input->>'lease_token')::uuid or w.lease_until<=now() or w.kind not in ('prepare','interview','research') then perform crm_private.fail('FORBIDDEN','Owned research lease required');end if;
   if w.version is distinct from (input->>'expected_version')::bigint then perform crm_private.fail('CONFLICT','Work changed');end if;
   if w.policy_version<>p.version or not crm_private.automation_work_enabled(p.policy,w.kind,w.checkpoint) then perform crm_private.fail('FORBIDDEN','Policy paused or changed');end if;
   select c1.* into c from public.companies c1 join public.jobs j on j.user_id=c1.user_id and j.company_id=c1.id where c1.user_id=owner and j.id=w.job_id and c1.id=(input->>'company_id')::uuid;
   if c.id is null then perform crm_private.fail('FORBIDDEN','Guide must belong to work company');end if;
   if c.version is distinct from (input->>'company_version')::bigint then perform crm_private.fail('CONFLICT','Company changed');end if;
   select coalesce(max(version),0) into v from public.automation_company_guides where user_id=owner and company_id=c.id;
   if v is distinct from (input->>'expected_guide_version')::bigint then perform crm_private.fail('CONFLICT','Guide changed');end if;
   perform crm_private.validate_company_guide(input->'content');
   insert into public.automation_company_guides(user_id,company_id,version,company_version,content,source_fingerprint,work_id)
   values(owner,c.id,v+1,c.version,input->'content',input->>'source_fingerprint',w.id) returning * into g;
   r=jsonb_build_object('guide',to_jsonb(g),'stale',false);
  end if;
  insert into public.mutation_receipts(user_id,idempotency_key,operation,payload_hash,response) values(owner,key,op,hash,r);return r;
 end if;
 if op='automation.pack.save' and input->'content'->>'content_version'='2' and not exists(select 1 from public.mutation_receipts where user_id=owner and idempotency_key=(input->>'idempotency_key')::uuid) then
  perform crm_private.validate_automation_pack(input->'content');
  select * into i from public.automation_interview_intents where user_id=owner and job_id=(input->>'job_id')::uuid;
  if input->'content'->'guide_version'<>'null'::jsonb and not exists(select 1 from public.automation_company_guides g1 join public.jobs j1 on j1.user_id=g1.user_id and j1.company_id=g1.company_id where j1.user_id=owner and j1.id=(input->>'job_id')::uuid and g1.version=(input->'content'->>'guide_version')::bigint and g1.version=(select max(version) from public.automation_company_guides where user_id=owner and company_id=g1.company_id) and g1.content=input->'content'->'company_guide' and g1.company_version=(input->>'company_version')::bigint) then perform crm_private.fail('CONFLICT','Pack guide changed');end if;
  if input->'content'->'communication'->'english_level' is distinct from coalesce((select value->'fact' from jsonb_array_elements(coalesce(i.preparation_context,'[]')) where value->>'topic'='english_level' limit 1),'null'::jsonb) then perform crm_private.fail('VALIDATION_ERROR','English level requires owner confirmation');end if;
  if input->'content'->>'depth'='interview' and (not coalesce(i.active,false) or input->'content'->>'context_revision' is distinct from i.revision or input->'content'->'rounds' is distinct from crm_private.interview_context(owner,i.job_id)) then perform crm_private.fail('CONFLICT','Interview context changed');end if;
 end if;
 return crm_private.automation_operation_before_understanding(owner,op,input);
exception when sqlstate 'CR001' then return jsonb_build_object('error',SQLERRM::jsonb);
 when unique_violation then return jsonb_build_object('error',jsonb_build_object('code','CONFLICT','message','Work or request identity already exists','retryable',false));
 when invalid_text_representation or check_violation or not_null_violation or foreign_key_violation or numeric_value_out_of_range or invalid_datetime_format then return jsonb_build_object('error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid preparation input','retryable',false));
end $function$
;

CREATE OR REPLACE FUNCTION crm_private.notification_operation(owner uuid, op text, input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
#variable_conflict use_variable
declare s public.notification_state;b public.notification_batches;receipt public.mutation_receipts;key uuid;hash text;result jsonb;items jsonb;lim integer;cur jsonb;cutoff timestamptz;begin
 if owner is null or owner is distinct from auth.uid() or not crm_private.is_owner() then perform crm_private.fail('FORBIDDEN','Live owner session required');end if;
 if jsonb_typeof(input)<>'object' or octet_length(input::text)>16384 then perform crm_private.fail('VALIDATION_ERROR','Expected bounded input');end if;
 perform pg_advisory_xact_lock(hashtextextended(owner::text,0));
 select * into s from public.notification_state where user_id=owner for update;
 if not found then s.user_id=owner;s.version=1;s.live_email=false;s.disclosure='generic';end if;
 if op='notifications.preferences' then
  if input<>'{}' then perform crm_private.fail('VALIDATION_ERROR','Preferences takes no input');end if;
  return to_jsonb(s);
 elsif op='notifications.list' then
  if input-array['limit','cursor','job_id','unread']<>'{}' then perform crm_private.fail('VALIDATION_ERROR','Unknown list input');end if;
  lim=coalesce((input->>'limit')::int,20);if lim not between 1 and 50 then perform crm_private.fail('VALIDATION_ERROR','Invalid limit');end if;
  if input ? 'cursor' then cur=convert_from(decode(input->>'cursor','base64'),'UTF8')::jsonb;if cur->>'job_id' is distinct from input->>'job_id' or cur->>'unread' is distinct from input->>'unread' then perform crm_private.fail('VALIDATION_ERROR','Cursor filters changed');end if;end if;
  select coalesce(jsonb_agg(crm_private.notification_batch(x) order by x.created_at desc,x.id desc),'[]'::jsonb) into items from (
   select nb.* from public.notification_batches nb where user_id=owner and (not coalesce((input->>'unread')::boolean,false) or read_at is null)
   and (input->>'job_id' is null or exists(select 1 from public.automation_events e where e.user_id=owner and e.batch_id=nb.id and e.job_id=(input->>'job_id')::uuid))
   and (cur is null or (nb.created_at,nb.id)<((cur->>'at')::timestamptz,(cur->>'id')::uuid)) order by nb.created_at desc,nb.id desc limit lim+1) x;
  result=jsonb_build_object('items',case when jsonb_array_length(items)>lim then items-(lim) else items end,'has_more',jsonb_array_length(items)>lim,'next_cursor',case when jsonb_array_length(items)>lim then encode(convert_to(jsonb_build_object('at',items->(lim-1)->>'created_at','id',items->(lim-1)->>'id','job_id',input->>'job_id','unread',input->>'unread')::text,'UTF8'),'base64') else null end,'state_version',s.version,'cutoff',clock_timestamp(),'unread_count',(select count(*) from public.notification_batches where user_id=owner and read_at is null));return result;
 elsif op='notifications.get' then
  if input-array['id','job_id','cursor','limit']<>'{}' or not input ? 'id' then perform crm_private.fail('VALIDATION_ERROR','Batch required');end if;
  select * into b from public.notification_batches where user_id=owner and id=(input->>'id')::uuid;
  if not found then perform crm_private.fail('NOT_FOUND','Notification unavailable');end if;
  if input->>'job_id' is not null and not exists(select 1 from public.automation_events where user_id=owner and batch_id=b.id and job_id=(input->>'job_id')::uuid) then perform crm_private.fail('NOT_FOUND','Vacancy not in notification');end if;
  lim=coalesce((input->>'limit')::int,20);if lim not between 1 and 50 then perform crm_private.fail('VALIDATION_ERROR','Invalid limit');end if;
  if input ? 'cursor' then cur=convert_from(decode(input->>'cursor','base64'),'UTF8')::jsonb;if cur->>'batch' is distinct from b.id::text or cur->>'job' is distinct from input->>'job_id' then perform crm_private.fail('VALIDATION_ERROR','Cursor filters changed');end if;end if;
  items=crm_private.notification_items(owner,b.id,(input->>'job_id')::uuid,(cur->>'after')::uuid,lim+1);
  return jsonb_build_object('batch',crm_private.notification_batch(b),'items',case when jsonb_array_length(items)>lim then items-lim else items end,'has_more',jsonb_array_length(items)>lim,'next_cursor',case when jsonb_array_length(items)>lim then encode(convert_to(jsonb_build_object('batch',b.id,'job',input->>'job_id','after',items->(lim-1)->>'job_id')::text,'UTF8'),'base64') else null end);
 end if;
 perform crm_private.validate(input-array['read','live_email','disclosure','cutoff'],array['id','idempotency_key','expected_version']);
 perform crm_private.required(input,array['idempotency_key','expected_version']);key=(input->>'idempotency_key')::uuid;hash=encode(extensions.digest(op||input::text,'sha256'),'hex');
 select * into receipt from public.mutation_receipts where user_id=owner and idempotency_key=key;
 if found then if receipt.operation<>op or receipt.payload_hash<>hash then perform crm_private.fail('IDEMPOTENCY_CONFLICT','Changed request identity');end if;return receipt.response;end if;
 insert into public.notification_state(user_id) values(owner) on conflict do nothing;
 if op='notifications.read' then
  if input-array['idempotency_key','expected_version','id','read']<>'{}' or jsonb_typeof(input->'read') is distinct from 'boolean' then perform crm_private.fail('VALIDATION_ERROR','Guarded read input required');end if;
  perform crm_private.required(input,array['id','read']);
  select * into b from public.notification_batches where user_id=owner and id=(input->>'id')::uuid for update;
  if b.id is null then perform crm_private.fail('NOT_FOUND','Notification unavailable');end if;
  if b.version<>(input->>'expected_version')::bigint then perform crm_private.fail('CONFLICT','Notification changed','expected_version',b.version);end if;
  update public.notification_batches set read_at=case when (input->>'read')::boolean then now() end,version=version+1 where user_id=owner and id=b.id returning * into b;
  update public.notification_state set version=version+1 where user_id=owner;
  result=crm_private.notification_batch(b);
 elsif op in ('notifications.mark_all','notifications.configure') then
  if s.version<>(input->>'expected_version')::bigint then perform crm_private.fail('CONFLICT','Notification state changed','expected_version',s.version);end if;
  if op='notifications.mark_all' then
   if input-array['idempotency_key','expected_version','cutoff']<>'{}' or jsonb_typeof(input->'cutoff') is distinct from 'string' then perform crm_private.fail('VALIDATION_ERROR','Cutoff required');end if;
   cutoff=(input->>'cutoff')::timestamptz;if cutoff>now() then perform crm_private.fail('VALIDATION_ERROR','Future cutoff');end if;
   update public.notification_batches set read_at=now(),version=version+1 where user_id=owner and updated_at<=cutoff and read_at is null;
  else
   if input-array['idempotency_key','expected_version','live_email','disclosure']<>'{}' or jsonb_typeof(input->'live_email') is distinct from 'boolean' or input->>'disclosure' not in ('generic','vacancy_summary') then perform crm_private.fail('VALIDATION_ERROR','Explicit disclosure and live preference required');end if;
   perform crm_private.required(input,array['live_email','disclosure']);
   update public.notification_state set live_email=(input->>'live_email')::boolean,disclosure=input->>'disclosure' where user_id=owner;
  end if;
  update public.notification_state set version=version+1 where user_id=owner returning * into s;result=to_jsonb(s);
 else perform crm_private.fail('VALIDATION_ERROR','Unknown notification operation');end if;
 insert into public.mutation_receipts(user_id,idempotency_key,operation,payload_hash,response) values(owner,key,op,hash,result);return result;
exception when sqlstate 'CR001' then return jsonb_build_object('error',SQLERRM::jsonb);
 when invalid_text_representation or invalid_parameter_value or check_violation or not_null_violation or invalid_datetime_format or datetime_field_overflow or character_not_in_repertoire or untranslatable_character then return jsonb_build_object('error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid notification input','retryable',false));
end $function$
;

CREATE OR REPLACE FUNCTION crm_private.enqueue_interview(owner uuid, job uuid, origin text, context jsonb DEFAULT NULL::jsonb, manual boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare p public.automation_policies;pr public.automation_profiles;j public.jobs;w public.automation_work;i public.automation_interview_intents;rev text;begin
 perform pg_advisory_xact_lock(hashtextextended(owner::text,0));
 select * into j from public.jobs where user_id=owner and id=job;
 if not found then perform crm_private.fail('NOT_FOUND','Vacancy not found');end if;
 if j.stage in ('rejected','archived') and not manual then
  update public.automation_interview_intents set active=false where user_id=owner and job_id=job;
  update public.automation_work set state='cancelled',version=version+1,updated_at=now() where user_id=owner and job_id=job and kind='interview' and state in ('queued','waiting','blocked') and checkpoint->>'provider_id' is null;
  return null;
 end if;
 select * into i from public.automation_interview_intents where user_id=owner and job_id=job;
 context=coalesce(context,i.preparation_context,'[]');
 rev=crm_private.interview_revision(owner,job,context);
 insert into public.automation_interview_intents(user_id,job_id,origin,preparation_context,revision)
 values(owner,job,origin,context,rev) on conflict(user_id,job_id) do update set active=true,origin=excluded.origin,
 preparation_context=excluded.preparation_context,revision=excluded.revision;
 select * into p from public.automation_policies where user_id=owner;
 if not found then return null;end if;
 select * into pr from public.automation_profiles where user_id=owner order by (resume_id=j.resume_id) desc nulls last,id limit 1;
 if not found then return null;end if;
 select * into w from public.automation_work where user_id=owner and job_id=job and kind='interview' and checkpoint->>'content_version'='2' and (state in ('queued','running','waiting','blocked')
  or state='failed' and error='RETRY_LIMIT' and not manual and not exists(select 1 from public.automation_packs k where k.user_id=owner and k.job_id=job and k.created_at>automation_work.created_at))
 order by state='failed',created_at desc for update limit 1;
 if found and manual and w.state='blocked' and coalesce(w.error,'') like '%CONFLICT%' then
  update public.automation_work set state='cancelled',version=version+1,updated_at=now() where id=w.id;
  w.id=null;
 end if;
 if w.id is not null then
  if w.state='failed' then return w.id;end if;
  if w.state<>'running' and (manual or w.policy_version<>p.version) then
   update public.automation_work set policy_version=p.version,state=case when error='EXA_CREATE_AMBIGUOUS' then state else 'queued' end,
   checkpoint=checkpoint||case when manual then '{"on_demand_scope":"interview"}'::jsonb else '{}'::jsonb end,
   next_attempt_at=now(),version=version+1 where id=w.id;
  end if;
  return w.id;
 end if;
 if exists(select 1 from public.automation_packs k join public.resumes r on r.user_id=k.user_id and r.id=k.resume_id
 join public.companies c on c.user_id=j.user_id and c.id=j.company_id
 where k.user_id=owner and k.job_id=job and k.content->>'depth'='interview' and k.content->>'context_revision'=rev
 and k.resume_version=r.version and r.active) then return null;end if;
 if crm_private.paid_create_unresolved(owner,job) then return null;end if;
 insert into public.automation_work(user_id,profile_id,policy_version,kind,job_id,checkpoint)
 values(owner,pr.id,p.version,'interview',job,jsonb_build_object('content_version',2,'phase','evidence-review')||case when manual then '{"on_demand_scope":"interview"}'::jsonb else '{}'::jsonb end) returning id into w.id;
 return w.id;
end $function$
;

CREATE OR REPLACE FUNCTION crm_private.capture_interview_intent()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
 if auth.uid() is distinct from new.user_id or not crm_private.is_owner() then return new;end if;
 if tg_table_name='jobs' then
  if current_setting('crm.operation',true) in ('jobs.transition','jobs.upsert','contacts.upsert') and new.stage='interview'
   and (tg_op='INSERT' or old.stage is distinct from new.stage) then perform crm_private.enqueue_interview(new.user_id,new.id,'invitation');end if;
 else
  if current_setting('crm.operation',true)='interviews.upsert' and new.state='planned' and
   (tg_op='INSERT' or (to_jsonb(old)-array['version','updated_at','notes','interviewer_notes','meeting_url','next_step']) is distinct from (to_jsonb(new)-array['version','updated_at','notes','interviewer_notes','meeting_url','next_step'])) then
    perform crm_private.enqueue_interview(new.user_id,new.job_id,'round');
  elsif tg_op='UPDATE' and old.state='planned' and new.state='cancelled' then
   if not exists(select 1 from public.interviews where user_id=new.user_id and job_id=new.job_id and state='planned') then
    update public.automation_interview_intents set active=false where user_id=new.user_id and job_id=new.job_id;
   else perform crm_private.enqueue_interview(new.user_id,new.job_id,'round');end if;
  end if;
 end if;
 return new;
end $function$
;

CREATE OR REPLACE FUNCTION crm_private.contact_erasure(owner uuid, op text, input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
#variable_conflict use_variable
declare target uuid;copies jsonb;counts jsonb;fingerprint text;ids text[];key uuid;hash text;receipt public.mutation_receipts;result jsonb;row jsonb;records jsonb;item jsonb;linked uuid;version bigint;
 remaining jsonb='["Original protegido index.html y copias del navegador/localStorage anterior: vencimiento desconocido", "Exportaciones descargadas, archivos privados de migración/respaldo y borradores sin conexión: vencimiento desconocido", "Respaldos de la base de datos/PITR, copias de proveedores o terceros y puntos de recuperación privados: vencimiento desconocido"]';
 limitations jsonb='["Solo se borran copias estructuradas del CRM; se conservan identificadores, relaciones, fechas y estados históricos como referencias de la persona eliminada", "Las menciones en notas de vacantes, empresas o entrevistas, enlaces de reunión, CVs, preparaciones e investigaciones requieren revisión por separado; no se buscan ni sustituyen nombres por suposición", "Se borran los mensajes, errores y referencias externas vinculados, y todas las notas compartidas sobre entrevistadores; se conservan los datos de la entrevista y las otras notas", "Un registro con otro identificador o procedencia de importación no puede reconocerse como la misma persona sin revisión del propietario"]';
begin
 if not crm_private.is_owner() or owner is distinct from auth.uid() then perform crm_private.fail('FORBIDDEN','Owner session required');end if;
 if auth.jwt()->>'client_id' is not null or current_setting('crm.actor_kind',true)='worker' then perform crm_private.fail('FORBIDDEN','Erasure requires browser owner review');end if;
 perform crm_private.validate(case when op='contacts.erase' then input-'owner_reviewed' else input end,case when op='contacts.preview_erasure' then array['id'] else array['id','expected_version','inventory_hash','owner_reviewed','idempotency_key'] end);
 perform crm_private.required(input,array['id']);target=(input->>'id')::uuid;
 perform pg_advisory_xact_lock(hashtextextended(owner::text,0));
 perform pg_advisory_xact_lock(hashtextextended('crm-audit-retention:'||owner::text,0));
 if op='contacts.erase' then
  -- owner_reviewed is a strict boolean checked separately from the shared scalar validator.
  perform crm_private.required(input,array['expected_version','inventory_hash','owner_reviewed','idempotency_key']);
  if input->'owner_reviewed'<>'true'::jsonb or input->>'inventory_hash'!~'^[a-f0-9]{64}$' then perform crm_private.fail('VALIDATION_ERROR','Review the current erasure inventory');end if;
  key=(input->>'idempotency_key')::uuid;hash=encode(extensions.digest(op||input::text,'sha256'),'hex');
  select * into receipt from public.mutation_receipts where user_id=owner and idempotency_key=key;
  if found then
   if receipt.operation<>op or receipt.payload_hash<>hash then perform crm_private.fail('IDEMPOTENCY_CONFLICT','Idempotency key has different input');end if;
   return receipt.response;
  end if;
 end if;
 if exists(select 1 from crm_private.contact_erasures where user_id=owner and contact_id=target) then perform crm_private.fail('CONFLICT','Contact already erased');end if;
 perform crm_private.record('contacts',owner,target,case when op='contacts.erase' then (input->>'expected_version')::bigint end);
 copies=crm_private.erasure_inventory(owner,target);fingerprint=encode(extensions.digest(copies::text,'sha256'),'hex');
 select jsonb_object_agg(k,case when k='contact' then 1 else jsonb_array_length(v) end) into counts from jsonb_each(copies) x(k,v);
 if op='contacts.preview_erasure' then return jsonb_build_object('contact_id',target,'expected_version',copies->'contact'->'version','inventory_hash',fingerprint,'inventory',counts,'remaining_copies',remaining,'limitations',limitations);end if;
 if fingerprint<>input->>'inventory_hash' then perform crm_private.fail('CONFLICT','Known copies changed; review a fresh preview','inventory_hash');end if;
 select array_agg(v) into ids from (select target::text v union select x->>'id' from jsonb_array_elements(copies->'outreach'||(copies->'interviews')) x
  union select nullif(copies->'contact'->>k,'') from unnest(array['linkedin_url','email']) k) s where v is not null;
 perform set_config('crm.operation',op,true);perform set_config('crm.request_id',key::text,true);perform set_config('crm.actor_kind','user',true);perform set_config('crm.reason','',true);
 perform set_config('crm.contact_erasure',owner::text,true);perform set_config('crm.erasure_ids',array_to_string(ids,E'\x1f'),true);
 update public.contacts set name='Contacto eliminado',role=null,email=null,linkedin_url=null,draft_note='',draft_message='',notes='',archived_at=coalesce(archived_at,now()) where user_id=owner and id=target returning contacts.version into version;
 update public.outreach_events set body='',error=null,external_ref=null where user_id=owner and contact_id=target;
 update public.interviews set interviewer_notes='' where user_id=owner and target=any(interviewer_ids);
 update public.mutation_receipts set response=crm_private.erasure_response(response,ids) where user_id=owner and crm_private.erasure_mentions(response,ids);
 for row in select value from jsonb_array_elements(copies->'import_tasks') loop
  records='[]';
  for item in select value from jsonb_array_elements(coalesce(row->'payload'->'records','[]')) loop
   select entity_id into linked from public.legacy_links where user_id=owner and import_namespace=row->'payload'->>'import_namespace' and entity_type=item->>'entity_type' and legacy_id=item->>'legacy_id';
   if linked::text=any(ids) or crm_private.erasure_mentions(item,ids) then
    -- Keep import identity as an anti-replay marker, never a valid personal-data import.
    item=jsonb_set(item,'{data}',crm_private.audit_payload_metadata(item->'data')||jsonb_build_object('id',coalesce(linked::text,item->'data'->>'id'),'erased',true));
   end if;
   records=records||jsonb_build_array(item);
  end loop;
  update public.crm_jobs set payload=case when row->'payload' ? 'records' then jsonb_set(row->'payload','{records}',records) else payload end,
   result=crm_private.erasure_response(result,ids),error=null,
   state=case when state in ('queued','running') then 'cancelled' else state end,lease_token=null,lease_until=null
  where user_id=owner and id=(row->>'id')::uuid;
 end loop;
 update public.automation_work set checkpoint=crm_private.erasure_response(checkpoint,ids),version=version+1,updated_at=now() where user_id=owner and crm_private.erasure_mentions(checkpoint,ids);
 -- Includes the erasure transaction's newly generated snapshots, so no old body survives.
 update public.audit_events set before=crm_private.audit_payload_metadata(before),after=crm_private.audit_payload_metadata(after)
 where user_id=owner and (entity_id::text=any(ids) or crm_private.erasure_mentions(before,ids) or crm_private.erasure_mentions(after,ids));
 delete from crm_private.embeddings where user_id=owner and entity_type='contacts' and entity_id=target;
 insert into crm_private.contact_erasures(user_id,contact_id) values(owner,target);
 perform set_config('crm.contact_erasure','',true);perform set_config('crm.erasure_ids','',true);
 result=jsonb_build_object('contact_id',target,'erased',true,'version',version,'inventory',counts,'remaining_copies',remaining,'limitations',limitations);
 insert into public.mutation_receipts(user_id,idempotency_key,operation,payload_hash,response) values(owner,key,op,hash,result);
 return result;
exception when sqlstate 'CR001' then return jsonb_build_object('error',SQLERRM::jsonb);
 when others then return jsonb_build_object('error',jsonb_build_object('code','TEMPORARY_FAILURE','message','Erasure unavailable; preserve the reviewed request','retryable',true));
end $function$
;

CREATE OR REPLACE FUNCTION crm_private.operation(owner uuid, op text, input jsonb, actor text DEFAULT 'user'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
#variable_conflict use_variable
declare entity text; allowed text[]; mut boolean=false; key uuid; hash text; receipt public.mutation_receipts; result jsonb; r jsonb; before_row jsonb; c jsonb; target jsonb; changed jsonb='[]'; count_jobs integer; count_contacts integer; count_outreach integer; id uuid; expected bigint; a uuid; k text; item jsonb; stages text[]=array['radar','review','ready','applied','invited','messaged','replied','interview','offer']; error_field text;
begin
 if owner is null then perform crm_private.fail('UNAUTHENTICATED','Sign in to continue'); end if;
 if not exists(select 1 from crm_private.settings where owner_id=owner) then perform crm_private.fail('FORBIDDEN','This account is not the CRM owner'); end if;
 if input is null or jsonb_typeof(input)<>'object' or octet_length(input::text)>1048576 then perform crm_private.fail('VALIDATION_ERROR','Expected object of at most 1 MiB'); end if;
 entity=case split_part(op,'.',1) when 'outreach' then 'outreach_events' else split_part(op,'.',1) end;
 case op
 when 'jobs.list' then allowed=array['stage','company_id','query','cursor','limit'];
 when 'contacts.search' then allowed=array['query','company_id','job_id','status','cursor','limit'];
 when 'companies.list','sources.list' then allowed=array['query','cursor','limit'];
 when 'outreach.list' then allowed=array['job_id','contact_id','state','cursor','limit'];
 when 'interviews.list' then allowed=array['job_id','state','cursor','limit'];
 when 'resumes.list' then allowed=array['country','track','active','cursor','limit'];
 when 'jobs.get','resumes.get_download','companies.health','companies.preview_archive' then allowed=array['id'];
 when 'companies.preview_merge' then allowed=array['source_id','target_id'];
 when 'tasks.get' then allowed=array['task_id'];
 when 'dashboard.summary' then allowed=array['from','to'];
 when 'search.semantic' then allowed=array['entity_type','query','embedding','model','limit'];
 when 'jobs.upsert','contacts.upsert','companies.upsert','sources.upsert','interviews.upsert' then allowed=crm_private.editable(entity)||array['id','expected_version']; mut=true;
 when 'jobs.transition' then allowed=array['id','expected_version','stage','reason','applied_at']; mut=true;
 when 'companies.merge' then allowed=array['source_id','source_version','target_id','target_version','reason','confirmation']; mut=true;
 when 'companies.archive' then allowed=array['id','expected_version','reason','confirmation']; mut=true;
 when 'outreach.draft' then allowed=array['body','channel','kind','contact_id','job_id','resume_id']; mut=true;
 when 'outreach.queue' then allowed=array['id','expected_version','scheduled_for']; mut=true;
 when 'outreach.mark_sent' then allowed=array['id','expected_version','occurred_at','confirmation_ref']; mut=true;
 when 'outreach.record_response' then allowed=array['contact_id','job_id','body','occurred_at']; mut=true;
 when 'verifications.record' then allowed=crm_private.editable('verifications'); mut=true;
 when 'tasks.submit' then allowed=array['kind','payload']; mut=true;
 when 'tasks.cancel' then allowed=array['task_id','expected_version']; mut=true;
 when 'resumes.finalize' then allowed=crm_private.editable('resumes'); mut=true;
 when 'push.subscribe' then allowed=array['endpoint','p256dh','auth','device_label']; mut=true;
 when 'push.deactivate' then allowed=array['endpoint','id']; mut=true;
 else perform crm_private.fail('VALIDATION_ERROR','Unknown operation','operation');
 end case;
 if mut then allowed=allowed||array['idempotency_key']; end if;
 perform crm_private.validate(input,allowed);
 if op='contacts.search' and input ? 'status' and input->>'status' not in ('uncontacted','invited','connected','messaged','replied','interview','no_response') then perform crm_private.fail('VALIDATION_ERROR','Invalid contact status','status'); end if;
 if op='interviews.list' and input ? 'state' and input->>'state' not in ('planned','completed','cancelled') then perform crm_private.fail('VALIDATION_ERROR','Invalid interview state','state'); end if;
 if op='outreach.list' and input ? 'state' and input->>'state' not in ('draft','queued','sent','failed','responded','cancelled') then perform crm_private.fail('VALIDATION_ERROR','Invalid outreach state','state'); end if;
 if mut then
  perform crm_private.required(input,array['idempotency_key']); key=(input->>'idempotency_key')::uuid; hash=encode(extensions.digest(op||input::text,'sha256'),'hex');
  -- Serialize this owner's operations: protects cascade/version races and identical receipts.
  -- ponytail: one owner's CRM needs no per-record lock graph; split locks only if concurrent throughput matters.
  perform pg_advisory_xact_lock(hashtextextended(owner::text,0));
  select * into receipt from public.mutation_receipts where user_id=owner and idempotency_key=key;
  if found then
   if receipt.operation<>op or receipt.payload_hash<>hash then perform crm_private.fail('IDEMPOTENCY_CONFLICT','Idempotency key was used for different input','idempotency_key'); end if;
   return receipt.response;
  end if;
  perform set_config('crm.operation',op,true); perform set_config('crm.request_id',key::text,true); perform set_config('crm.actor_kind',actor,true); perform set_config('crm.reason',coalesce(input->>'reason',''),true);
 end if;
 id=(input->>'id')::uuid; expected=(input->>'expected_version')::bigint;
 if op like '%.list' or op='contacts.search' then
  result=crm_private.page(entity,owner,input);
 elsif op in ('jobs.upsert','contacts.upsert','companies.upsert','sources.upsert','interviews.upsert') then
  if id is null then
   perform crm_private.required(input,case entity when 'jobs' then array['company_id','title'] when 'contacts' then array['company_id','name'] when 'companies' then array['name'] when 'sources' then array['name','kind'] else array['job_id','state','timezone'] end);
  end if;
  if op='companies.upsert' and input->>'archived_at' is not null then perform crm_private.fail('VALIDATION_ERROR','Use companies.archive after a preview','archived_at'); end if;
  if op='jobs.upsert' then
   if id is null and input->>'stage' in ('rejected','archived') and actor<>'worker' then perform crm_private.fail('VALIDATION_ERROR','Create an active job, then use jobs.transition with a reason','stage'); end if;
   if id is not null and input ? 'applied_at' and input->'applied_at'='null'::jsonb then perform crm_private.fail('VALIDATION_ERROR','Use an explicit correction to preserve application evidence','applied_at'); end if;
   if id is not null and input ? 'stage' then perform crm_private.fail('VALIDATION_ERROR','Use jobs.transition for stage changes','stage'); end if;
   if id is null and input->>'stage' in ('applied','invited','messaged','replied','interview','offer') and input->>'applied_at' is null and actor<>'worker' then perform crm_private.fail('VALIDATION_ERROR','Application date is required','applied_at'); end if;
   if id is null and input->>'source_id' is not null and input->>'source_posting_id' is not null then
    select to_jsonb(j) into r from public.jobs j where user_id=owner and source_id=(input->>'source_id')::uuid and source_posting_id=input->>'source_posting_id';
   end if;
  end if;
  if r is null then r=crm_private.save(entity,owner,input-array['id','expected_version','idempotency_key'],id,expected); end if;
  result=r;
  if op='jobs.upsert' then
   -- ponytail: cap review hints at 50; jobs.list pages larger duplicate groups.
   result=r||jsonb_build_object('duplicate_hints',to_jsonb(array(select j.id from public.jobs j where j.user_id=owner and j.id<>(r->>'id')::uuid and ((j.company_id=(r->>'company_id')::uuid and lower(trim(j.title))=lower(trim(r->>'title'))) or (j.posting_url is not null and r->>'posting_url' is not null and crm_private.normalized_url(j.posting_url)=crm_private.normalized_url(r->>'posting_url'))) order by j.created_at,j.id limit 50)));
  end if;
  if op='contacts.upsert' then changed=crm_private.advance_contact(owner,r); result=jsonb_build_object('contact',r,'changed_jobs',changed); end if;
 elsif op='jobs.transition' then
  perform crm_private.required(input,array['id','expected_version','stage']); before_row=crm_private.record('jobs',owner,id,expected);
  if input->>'stage' not in ('radar','review','ready','applied','invited','messaged','replied','interview','offer','rejected','archived') then perform crm_private.fail('VALIDATION_ERROR','Invalid stage','stage'); end if;
  if before_row->>'stage' in ('offer','rejected','archived') or array_position(stages,input->>'stage')<array_position(stages,before_row->>'stage') then
   if nullif(trim(input->>'reason'),'') is null then perform crm_private.fail('VALIDATION_ERROR','Reopening or backward movement needs a reason','reason'); end if;
  end if;
  if input->>'stage' in ('applied','invited','messaged','replied','interview','offer') and coalesce(input->>'applied_at',before_row->>'applied_at') is null then perform crm_private.fail('VALIDATION_ERROR','Confirm actual application date','applied_at'); end if;
  r=crm_private.save('jobs',owner,jsonb_build_object('stage',input->'stage')||case when input ? 'applied_at' then jsonb_build_object('applied_at',input->'applied_at','applied_date_precision','instant') else '{}' end,id,expected);
  select ae.id into a from public.audit_events ae where ae.user_id=owner and entity_id=id and request_id=key order by ae.created_at desc,ae.id desc limit 1;
  result=jsonb_build_object('job',r,'audit_event_id',a);
 elsif op='jobs.get' then
  perform crm_private.required(input,array['id']); r=crm_private.record('jobs',owner,id);
  result=r||jsonb_build_object('contacts',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.contacts t where user_id=owner and job_id=id),'interviews',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.interviews t where user_id=owner and job_id=id),'verification',(select to_jsonb(t) from public.verifications t where user_id=owner and job_id=id order by checked_at desc,t.id desc limit 1));
 elsif op in ('companies.merge','companies.preview_merge') then
  perform crm_private.required(input,array['source_id','target_id']);
  if input->>'source_id'=input->>'target_id' then perform crm_private.fail('VALIDATION_ERROR','Choose two different companies','target_id'); end if;
  r=crm_private.record('companies',owner,(input->>'source_id')::uuid,(input->>'source_version')::bigint);
  target=crm_private.record('companies',owner,(input->>'target_id')::uuid,(input->>'target_version')::bigint);
  select count(*) into count_jobs from public.jobs where user_id=owner and company_id=(r->>'id')::uuid;
  select count(*) into count_contacts from public.contacts where user_id=owner and company_id=(r->>'id')::uuid;
  if op='companies.preview_merge' then result=jsonb_build_object('source_version',r->'version','target_version',target->'version','jobs',count_jobs,'contacts',count_contacts);
  else
   perform crm_private.required(input,array['source_version','target_version','reason','confirmation']);
   if input->>'confirmation'<>'true' or trim(input->>'reason')='' then perform crm_private.fail('VALIDATION_ERROR','Confirm the cascade preview and provide a reason','confirmation'); end if;
   update public.jobs set company_id=(target->>'id')::uuid where user_id=owner and company_id=(r->>'id')::uuid;
   update public.contacts set company_id=(target->>'id')::uuid where user_id=owner and company_id=(r->>'id')::uuid;
   -- Append replacement verification while preserving original provenance.
   insert into public.verifications(user_id,company_id,status,checked_at,evidence_url,source_id,notes)
    select owner,(target->>'id')::uuid,status,checked_at,evidence_url,source_id,notes from public.verifications where user_id=owner and company_id=(r->>'id')::uuid;
   perform crm_private.save('companies',owner,jsonb_build_object('archived_at',now()),(r->>'id')::uuid,(r->>'version')::bigint);
   result=crm_private.save('companies',owner,'{}',(target->>'id')::uuid,(target->>'version')::bigint);
   -- Surviving company must acquire a new version even when only its relations changed.
   update public.companies set name=name where user_id=owner and public.companies.id=(target->>'id')::uuid returning to_jsonb(public.companies.*) into result;
  end if;
 elsif op in ('companies.archive','companies.preview_archive') then
  perform crm_private.required(input,array['id']); r=crm_private.record('companies',owner,id,expected);
  select count(*) into count_jobs from public.jobs where user_id=owner and company_id=id and stage<>'archived';
  select count(*) into count_contacts from public.contacts where user_id=owner and company_id=id and archived_at is null;
  select count(*) into count_outreach from public.outreach_events o where user_id=owner and state='queued' and (scheduled_for is null or scheduled_for>now()) and (job_id in (select j.id from public.jobs j where j.user_id=owner and company_id=id) or contact_id in (select ct.id from public.contacts ct where ct.user_id=owner and company_id=id));
  if op='companies.preview_archive' then result=jsonb_build_object('version',r->'version','jobs',count_jobs,'contacts',count_contacts,'outreach',count_outreach);
  else
   perform crm_private.required(input,array['expected_version','reason','confirmation']);
   if input->>'confirmation'<>'true' or trim(input->>'reason')='' then perform crm_private.fail('VALIDATION_ERROR','Confirm the cascade preview and provide a reason','confirmation'); end if;
   update public.outreach_events set state='cancelled' where user_id=owner and state='queued' and (scheduled_for is null or scheduled_for>now()) and (job_id in (select j.id from public.jobs j where j.user_id=owner and company_id=id) or contact_id in (select ct.id from public.contacts ct where ct.user_id=owner and company_id=id));
   update public.jobs set stage='archived' where user_id=owner and company_id=id and stage<>'archived';
   update public.contacts set archived_at=now() where user_id=owner and company_id=id and archived_at is null;
   r=crm_private.save('companies',owner,jsonb_build_object('archived_at',now()),id,expected);
   result=jsonb_build_object('company',r,'affected',jsonb_build_object('jobs',count_jobs,'contacts',count_contacts,'outreach',count_outreach));
  end if;
 elsif op='companies.health' then
  perform crm_private.required(input,array['id']); perform crm_private.record('companies',owner,id);
  result=jsonb_build_object('active_jobs',(select count(*) from public.jobs where user_id=owner and company_id=id and stage not in ('rejected','archived')),'last_outreach',(select max(occurred_at) from public.outreach_events where user_id=owner and (contact_id in (select ct.id from public.contacts ct where ct.user_id=owner and company_id=id) or job_id in (select j.id from public.jobs j where j.user_id=owner and company_id=id))),'sent',(select count(*) from public.outreach_events where user_id=owner and state='sent' and (contact_id in (select ct.id from public.contacts ct where ct.user_id=owner and company_id=id) or job_id in (select j.id from public.jobs j where j.user_id=owner and company_id=id))),'responded',(select count(*) from public.outreach_events where user_id=owner and state='responded' and (contact_id in (select ct.id from public.contacts ct where ct.user_id=owner and company_id=id) or job_id in (select j.id from public.jobs j where j.user_id=owner and company_id=id))));
 elsif op='outreach.draft' then
  perform crm_private.required(input,array['body','channel','kind']);
  if input->>'kind'='invitation' and length(input->>'body')>300 then perform crm_private.fail('VALIDATION_ERROR','Invitation note max 300 characters','body');end if;
  result=crm_private.save('outreach_events',owner,(input-'idempotency_key')||jsonb_build_object('state','draft'));
 elsif op in ('outreach.queue','outreach.mark_sent') then
  perform crm_private.required(input,array['id','expected_version']); r=crm_private.record('outreach_events',owner,id,expected);
  if op='outreach.queue' then
   perform crm_private.required(input,array['scheduled_for']);
   if r->>'state'<>'draft' then perform crm_private.fail('CONFLICT','Only draft outreach can be queued','state',(r->>'version')::bigint); end if;
   if (input->>'scheduled_for')::timestamptz<now() then perform crm_private.fail('VALIDATION_ERROR','Schedule must be in the future','scheduled_for'); end if;
   result=crm_private.save('outreach_events',owner,jsonb_build_object('state','queued','scheduled_for',input->'scheduled_for'),id,expected);
  else
   perform crm_private.required(input,array['occurred_at','confirmation_ref']);
   if r->>'state' not in ('draft','queued') then perform crm_private.fail('CONFLICT','Outreach is already settled','state',(r->>'version')::bigint); end if;
   result=crm_private.save('outreach_events',owner,jsonb_build_object('state','sent','occurred_at',input->'occurred_at','external_ref',input->'confirmation_ref'),id,expected);
   if r->>'kind'='application' and r->>'job_id' is not null then
    target=crm_private.record('jobs',owner,(r->>'job_id')::uuid);
    perform crm_private.save('jobs',owner,jsonb_build_object('applied_at',coalesce(target->>'applied_at',input->>'occurred_at'),'applied_date_precision',coalesce(target->>'applied_date_precision','instant'),'stage',case when target->>'stage' in ('radar','review','ready') then 'applied' else target->>'stage' end),(target->>'id')::uuid,(target->>'version')::bigint);
   end if;
   if r->>'contact_id' is not null then
    c=crm_private.record('contacts',owner,(r->>'contact_id')::uuid);
    c=crm_private.save('contacts',owner,jsonb_build_object('last_interacted_at',to_jsonb(greatest((c->>'last_interacted_at')::timestamptz,(input->>'occurred_at')::timestamptz)))||case when r->>'kind'='invitation' and c->>'status'='uncontacted' then jsonb_build_object('status','invited','invite_at',input->'occurred_at') when r->>'kind' in ('message','followup') and c->>'status' in ('uncontacted','invited','connected','no_response') then jsonb_build_object('status','messaged') else '{}'::jsonb end,(c->>'id')::uuid,(c->>'version')::bigint);
    perform crm_private.advance_contact(owner,c);
   end if;
  end if;
 elsif op='outreach.record_response' then
  perform crm_private.required(input,array['contact_id','body','occurred_at']); c=crm_private.record('contacts',owner,(input->>'contact_id')::uuid);
  if input->>'job_id' is not null and c->>'job_id' is distinct from input->>'job_id' then perform crm_private.fail('VALIDATION_ERROR','Response job must match contact association','job_id'); end if;
  r=crm_private.save('outreach_events',owner,jsonb_build_object('contact_id',input->'contact_id','job_id',coalesce(input->'job_id',c->'job_id'),'body',input->'body','occurred_at',input->'occurred_at','channel','manual','kind','response','state','responded'));
  c=crm_private.save('contacts',owner,case when c->>'status'='interview' then '{}'::jsonb else jsonb_build_object('status','replied') end||jsonb_build_object('last_interacted_at',to_jsonb(greatest((c->>'last_interacted_at')::timestamptz,(input->>'occurred_at')::timestamptz))),(c->>'id')::uuid,(c->>'version')::bigint);
  changed=crm_private.advance_contact(owner,c); result=jsonb_build_object('event',r,'contact',c,'changed_jobs',changed);
 elsif op='verifications.record' then
  perform crm_private.required(input,array['status','checked_at','notes']); result=crm_private.save('verifications',owner,input-'idempotency_key');
 elsif op='resumes.finalize' then
  perform crm_private.required(input,array['label','storage_path','checksum','media_type']);
  if split_part(input->>'storage_path','/',1)<>owner::text then perform crm_private.fail('FORBIDDEN','Resume path must belong to owner','storage_path'); end if;
  if not exists(select 1 from storage.objects where bucket_id='resumes' and name=input->>'storage_path') then perform crm_private.fail('NOT_FOUND','Upload the file before finalizing','storage_path'); end if;
  result=crm_private.save('resumes',owner,input-'idempotency_key');
  if coalesce((input->>'active')::boolean,true) then update public.resumes set active=false where user_id=owner and public.resumes.id<>(result->>'id')::uuid and active and country is not distinct from result->>'country' and track is not distinct from result->>'track'; end if;
  result=result-'storage_path';
 elsif op='resumes.get_download' then
  perform crm_private.required(input,array['id']); r=crm_private.record('resumes',owner,id); result=jsonb_build_object('storage_path',r->'storage_path','expires_in',300);
 elsif op='tasks.submit' then
  if input->>'kind'='bulk_import' then perform crm_private.reject_erased_import(owner,input->'payload');end if;
  perform crm_private.required(input,array['kind','payload']);
  if input->>'kind' not in ('bulk_import','embed_records') then perform crm_private.fail('VALIDATION_ERROR','Invalid task kind','kind'); end if;
  if jsonb_typeof(input->'payload')<>'object' or jsonb_typeof(input->'payload'->'records') is distinct from 'array' then perform crm_private.fail('VALIDATION_ERROR','Payload requires records array','payload'); end if;
  if jsonb_array_length(input->'payload'->'records') not between 1 and 50 then perform crm_private.fail('VALIDATION_ERROR','Batch must contain 1..50 records','payload.records'); end if;
  if input->>'kind'='bulk_import' then
   perform crm_private.validate(input->'payload',array['import_namespace','records']); perform crm_private.required(input->'payload',array['import_namespace']);
   for item in select value from jsonb_array_elements(input->'payload'->'records') loop
    perform crm_private.validate(item,array['entity_type','legacy_id','data']);
    perform crm_private.required(item,array['entity_type','legacy_id','data']);
    if item->>'entity_type' not in ('companies','sources','jobs','contacts','outreach_events','interviews','resumes','verifications') then perform crm_private.fail('VALIDATION_ERROR','Invalid import entity','entity_type'); end if;
    perform crm_private.validate(item->'data',crm_private.editable(item->>'entity_type')||array['id']);
    perform crm_private.required(item->'data',array['id']);
    perform crm_private.validate_entity(item->>'entity_type',(item->'data')-'id',true);
   end loop;
  else
   perform crm_private.validate(input->'payload',array['records']);
   for item in select value from jsonb_array_elements(input->'payload'->'records') loop
    perform crm_private.validate(item,array['entity_type','id']); perform crm_private.required(item,array['entity_type','id']);
    if item->>'entity_type' not in ('companies','jobs','contacts') then perform crm_private.fail('VALIDATION_ERROR','Invalid embedding entity','entity_type'); end if;
    perform crm_private.record(item->>'entity_type',owner,(item->>'id')::uuid);
   end loop;
  end if;
  insert into public.crm_jobs(user_id,kind,payload,request_id) values(owner,input->>'kind',input->'payload',key) returning to_jsonb(public.crm_jobs.*) into r;
  result=jsonb_build_object('task_id',r->'id','state',r->'state','version',r->'version');
 elsif op in ('tasks.get','tasks.cancel') then
  perform crm_private.required(input,array['task_id']); r=crm_private.record('crm_jobs',owner,(input->>'task_id')::uuid,expected);
  if op='tasks.cancel' then
   perform crm_private.required(input,array['expected_version']);
   if r->>'state'<>'queued' then perform crm_private.fail('CONFLICT','Only queued tasks can be cancelled','state',(r->>'version')::bigint); end if;
   update public.crm_jobs set state='cancelled' where user_id=owner and public.crm_jobs.id=(input->>'task_id')::uuid returning to_jsonb(public.crm_jobs.*) into r;
  end if;
  result=r-array['payload','lease_token','lease_until','request_id','user_id'];
 elsif op='push.subscribe' then
  perform crm_private.required(input,array['endpoint','p256dh','auth']);
  -- Allow known push vendors only. Never let a subscription become a worker SSRF request.
  if input->>'endpoint' !~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com|web\.push\.apple\.com)/[^[:space:]]+$' then perform crm_private.fail('VALIDATION_ERROR','Unsupported push endpoint','endpoint'); end if;
  if input->>'p256dh' !~ '^[A-Za-z0-9_-]{87}=?$' or input->>'auth' !~ '^[A-Za-z0-9_-]{22}==?$' and input->>'auth' !~ '^[A-Za-z0-9_-]{22}$' then perform crm_private.fail('VALIDATION_ERROR','Malformed push keys','p256dh'); end if;
  insert into public.push_subscriptions(user_id,endpoint,p256dh,auth,device_label) values(owner,input->>'endpoint',input->>'p256dh',input->>'auth',input->>'device_label') on conflict(user_id,endpoint) do update set active=true,p256dh=excluded.p256dh,auth=excluded.auth,device_label=excluded.device_label returning jsonb_build_object('id',public.push_subscriptions.id,'active',active,'version',version) into result;
 elsif op='push.deactivate' then
  if input->>'endpoint' is null and input->>'id' is null then perform crm_private.fail('VALIDATION_ERROR','Choose the device to deactivate','endpoint');end if;
  update public.push_subscriptions set active=false where user_id=owner and (input->>'endpoint' is null or endpoint=input->>'endpoint') and (input->>'id' is null or public.push_subscriptions.id=(input->>'id')::uuid); result=jsonb_build_object('active',false);
 elsif op='dashboard.summary' then
  if input ? 'from' and input ? 'to' and (input->>'from')::timestamptz>(input->>'to')::timestamptz then perform crm_private.fail('VALIDATION_ERROR','from must precede to','from'); end if;
  result=jsonb_build_object('counts_by_stage',(select coalesce(jsonb_object_agg(stage,n),'{}') from (select stage,count(*) n from public.jobs where user_id=owner group by stage) s),'unknown_application_dates',(select count(*) from public.jobs where user_id=owner and applied_at is null and stage in ('applied','invited','messaged','replied','interview','offer','rejected')),'dated_applications',(select count(*) from public.jobs where user_id=owner and applied_at is not null and (input->>'from' is null or applied_at>=(input->>'from')::timestamptz) and (input->>'to' is null or applied_at<=(input->>'to')::timestamptz)),'funnel',(select coalesce(jsonb_object_agg(stage,n),'{}') from (select after->>'stage' stage,count(distinct entity_id) n from public.audit_events where user_id=owner and entity_type='jobs' and action not like 'import.%' and after->>'applied_at' is not null and after->>'stage' is distinct from before->>'stage' and (input->>'from' is null or created_at>=(input->>'from')::timestamptz) and (input->>'to' is null or created_at<=(input->>'to')::timestamptz) group by after->>'stage') s));
 elsif op='search.semantic' then
  perform crm_private.required(input,array['entity_type','embedding','model']);
  if jsonb_typeof(input->'embedding')='array' then
   if exists(select 1 from jsonb_array_elements(input->'embedding') e where jsonb_typeof(e)<>'number') or (select coalesce(sum((e::text::float8)^2),0) from jsonb_array_elements(input->'embedding') e)=0 then perform crm_private.fail('VALIDATION_ERROR','Embedding must be a nonzero numeric vector','embedding'); end if;
  end if;
  if input->>'entity_type' not in ('jobs','contacts','companies') or jsonb_typeof(input->'embedding') is distinct from 'array' or jsonb_array_length(input->'embedding') not between 1 and 4096 then perform crm_private.fail('VALIDATION_ERROR','Supply entity_type and embedding vector','embedding'); end if;
  if coalesce((input->>'limit')::int,20) not between 1 and 50 then perform crm_private.fail('VALIDATION_ERROR','Limit must be 1..50','limit'); end if;
  execute format('select coalesce(jsonb_agg(r),''[]''::jsonb) from (select jsonb_build_object(''record'',to_jsonb(t),''score'',v.score,''verification'',(select to_jsonb(vf) from public.verifications vf where vf.user_id=$1 and %s order by checked_at desc,id desc limit 1)) r from public.%I t join crm_private.embeddings e on e.user_id=t.user_id and e.entity_id=t.id and e.entity_type=$2 and e.source_version=t.version cross join lateral (select case when sum(a*a)=0 or sum(b*b)=0 then null else greatest(-1.0,least(1.0,sum(a*b)/(sqrt(sum(a*a))*sqrt(sum(b*b))))) end score from unnest(e.vector,array(select value::text::float8 from jsonb_array_elements($3))) z(a,b)) v where t.user_id=$1 and v.score is not null and e.model=$5 and cardinality(e.vector)=jsonb_array_length($3) order by v.score desc nulls last,t.id limit $4) s',case input->>'entity_type' when 'jobs' then 'vf.job_id=t.id' when 'companies' then 'vf.company_id=t.id' else 'false' end,input->>'entity_type') into r using owner,input->>'entity_type',input->'embedding',coalesce((input->>'limit')::int,20),input->>'model';
  result=jsonb_build_object('items',r,'has_more',false,'next_cursor',null);
 end if;
 if mut then insert into public.mutation_receipts(user_id,idempotency_key,operation,payload_hash,response) values(owner,key,op,hash,result); end if;
 return result;
exception
 when sqlstate 'CR001' then return jsonb_build_object('error',SQLERRM::jsonb);
 when foreign_key_violation then return jsonb_build_object('error',jsonb_build_object('code','VALIDATION_ERROR','message','Reference must exist and belong to this owner','field','reference','retryable',false));
 when unique_violation then return jsonb_build_object('error',jsonb_build_object('code','CONFLICT','message','Identity already exists','retryable',false));
 when check_violation or not_null_violation or invalid_text_representation or datetime_field_overflow or invalid_parameter_value or numeric_value_out_of_range then
  get stacked diagnostics error_field=COLUMN_NAME;
  return jsonb_build_object('error',jsonb_strip_nulls(jsonb_build_object('code','VALIDATION_ERROR','message','Invalid field value','field',coalesce(nullif(error_field,''),case when SQLERRM like '%"jobs_money_currency"%' then 'currency' end),'retryable',false)));
 when others then return jsonb_build_object('error',jsonb_build_object('code','TEMPORARY_FAILURE','message','Operation failed; no changes were committed','retryable',true));
end $function$
;

CREATE OR REPLACE FUNCTION crm_private.automation_email_claim_v2()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare p public.automation_policies;s public.notification_state;d crm_private.automation_emails;b public.notification_batches;items jsonb;counts jsonb;start_at timestamptz;end_at timestamptz;begin
 perform pg_advisory_xact_lock(hashtextextended((select owner_id::text from crm_private.settings),0));
 select * into p from public.automation_policies where user_id=(select owner_id from crm_private.settings) for update;
 if p.user_id is null then return null;end if;
 
 perform crm_private.notification_prune();
 insert into public.notification_state(user_id) values(p.user_id) on conflict do nothing;
 select * into s from public.notification_state where user_id=p.user_id;
 for b in select * from public.notification_batches where user_id=p.user_id and window_end<=now() and window_end>now()-interval '24 hours' and not exists(select 1 from crm_private.automation_emails where user_id=p.user_id and batch_id=notification_batches.id) order by window_start loop
  if s.live_email or ((p.policy->>'closure_email')::boolean and exists(select 1 from public.automation_events where user_id=p.user_id and batch_id=b.id and kind='closed')) then
   if s.live_email then   items=crm_private.notification_items(p.user_id,b.id,null,null,50);
   else select coalesce(jsonb_agg(jsonb_build_object('job_id',x.job_id,'events',x.events) order by x.job_id),'[]'::jsonb) into items from (
    select e.job_id,jsonb_agg(jsonb_build_object('id',e.id,'kind',e.kind,'created_at',e.created_at,'job_version',e.job_version,'profile_id',e.profile_id,'cycle_id',e.cycle_id,'work_id',e.work_id,'snapshot',e.snapshot) order by e.created_at,e.id) events
    from public.automation_events e where e.user_id=p.user_id and e.batch_id=b.id and e.kind='closed' group by e.job_id order by e.job_id limit 50) x;
   end if;
   select jsonb_build_object('new',count(distinct job_id) filter(where kind='discovered'),'prepared',count(distinct job_id) filter(where kind='prepared'),'closed',count(distinct job_id) filter(where kind='closed'),'vacancies',count(distinct job_id),'incomplete',(select count(*) from public.automation_work where user_id=p.user_id and state in ('waiting','blocked','failed'))) into counts from public.automation_events where user_id=p.user_id and batch_id=b.id;
   if not s.live_email then counts=jsonb_build_object('new',0,'prepared',0,'closed',counts->'closed','vacancies',counts->'closed','incomplete',0);end if;
   if jsonb_array_length(items)>0 then insert into crm_private.automation_emails(user_id,window_key,kind,recipient,counts,batch_id,disclosure,content,legacy)
    select p.user_id,'batch/'||b.id,case when s.live_email then 'updates' else 'closed' end,email,counts,b.id,s.disclosure,jsonb_build_object('items',items,'batch_id',b.id,'window_start',b.window_start,'window_end',b.window_end),false from auth.users where id=p.user_id on conflict do nothing;end if;
  end if;
 end loop;
 if (p.policy->>'digest_email')::boolean and p.next_digest_at<=now() then
  end_at=(crm_private.notification_day_window(now(),p.policy->>'timezone')->>'end')::timestamptz;start_at=(crm_private.notification_day_window(now(),p.policy->>'timezone')->>'start')::timestamptz;
  select jsonb_build_object('new',count(distinct job_id) filter(where kind='discovered'),'prepared',count(distinct job_id) filter(where kind='prepared'),'closed',count(distinct job_id) filter(where kind='closed'),'vacancies',count(distinct job_id),'incomplete',(select count(*) from public.automation_work where user_id=p.user_id and state in ('waiting','failed','blocked'))) into counts from public.automation_events where user_id=p.user_id and created_at>=start_at and created_at<end_at;
  select coalesce(jsonb_agg(jsonb_build_object('job_id',x.job_id,'events',x.events) order by x.job_id),'[]'::jsonb) into items from (
   select e.job_id,jsonb_agg(jsonb_build_object('id',e.id,'kind',e.kind,'created_at',e.created_at,'job_version',e.job_version,'profile_id',e.profile_id,'cycle_id',e.cycle_id,'work_id',e.work_id,'snapshot',e.snapshot,'batch_id',e.batch_id) order by e.created_at,e.id) events from public.automation_events e where user_id=p.user_id and created_at>=start_at and created_at<end_at group by job_id order by job_id limit 50) x;
  if jsonb_array_length(items)>0 then insert into crm_private.automation_emails(user_id,window_key,kind,recipient,counts,disclosure,content,legacy)
   select p.user_id,'digest/'||end_at::text,'digest',email,counts,s.disclosure,jsonb_build_object('items',items,'window_start',start_at,'window_end',end_at),false from auth.users where id=p.user_id on conflict do nothing;end if;
  update public.automation_policies set next_digest_at=(date_trunc('day',now() at time zone(p.policy->>'timezone'))+interval '1 day') at time zone(p.policy->>'timezone') where user_id=p.user_id;
 end if;
 update crm_private.automation_emails set state='cancelled',lease_token=null,lease_until=null where user_id=p.user_id and state='queued' and (not coalesce(case kind when 'digest' then (p.policy->>'digest_email')::boolean when 'updates' then s.live_email else (p.policy->>'closure_email')::boolean end,false) or disclosure='vacancy_summary' and s.disclosure<>'vacancy_summary');
 update crm_private.automation_emails set state='failed',lease_token=null,lease_until=null where user_id=p.user_id and state='queued' and (attempts>=3 or first_attempt_at<now()-interval '23 hours') and (lease_until is null or lease_until<now());
 select * into d from crm_private.automation_emails where user_id=p.user_id and state='queued' and next_attempt_at<=now() and (lease_until is null or lease_until<now()) order by next_attempt_at,id for update skip locked limit 1;
 if not found then return null;end if;
 update crm_private.automation_emails set attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,now()),lease_token=gen_random_uuid(),lease_until=now()+interval '60 seconds' where id=d.id returning * into d;
 return jsonb_build_object('id',d.id,'recipient',d.recipient,'kind',d.kind,'counts',d.counts,'lease_token',d.lease_token,'disclosure',d.disclosure,'content',d.content,'request',d.request,'request_body',d.request_body,'legacy',d.legacy);
end $function$
;

CREATE OR REPLACE FUNCTION crm_private.automation_email_claim_legacy()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare p public.automation_policies;d crm_private.automation_emails;counts jsonb;window_start timestamptz;window_end timestamptz;begin
 select * into p from public.automation_policies where user_id=(select owner_id from crm_private.settings) for update;
 if p.user_id is null then return null;end if;
 if (p.policy->>'digest_email')::boolean and p.next_digest_at<=now() then
  window_end=date_trunc('day',now() at time zone (p.policy->>'timezone')) at time zone (p.policy->>'timezone');window_start=(date_trunc('day',now() at time zone (p.policy->>'timezone'))-interval '1 day') at time zone (p.policy->>'timezone');
  select jsonb_build_object('new',(select count(distinct job_id) from public.automation_events where user_id=p.user_id and kind='discovered' and created_at>=window_start and created_at<window_end),'prepared',(select count(distinct job_id) from public.automation_events where user_id=p.user_id and kind='prepared' and created_at>=window_start and created_at<window_end),'closed',(select count(distinct job_id) from public.automation_events where user_id=p.user_id and kind='closed' and created_at>=window_start and created_at<window_end),'incomplete',(select count(*) from public.automation_work where user_id=p.user_id and state in ('failed','blocked') and updated_at>=window_start and updated_at<window_end)) into counts;
  insert into crm_private.automation_emails(user_id,window_key,kind,recipient,counts) select p.user_id,'digest/'||window_end::text,'digest',email,counts from auth.users where id=p.user_id on conflict do nothing;
  update public.automation_policies set next_digest_at=(date_trunc('day',now() at time zone (p.policy->>'timezone'))+interval '1 day') at time zone (p.policy->>'timezone') where user_id=p.user_id;
 end if;
 update crm_private.automation_emails set state='cancelled',lease_token=null,lease_until=null where user_id=p.user_id and legacy and state='queued' and not (case kind when 'digest' then (p.policy->>'digest_email')::boolean else (p.policy->>'closure_email')::boolean end);
 update crm_private.automation_emails set state='failed',lease_token=null,lease_until=null where user_id=p.user_id and legacy and state='queued' and (attempts>=3 or first_attempt_at<now()-interval '23 hours') and (lease_until is null or lease_until<now());
 select * into d from crm_private.automation_emails where user_id=p.user_id and legacy and state='queued' and next_attempt_at<=now() and (lease_until is null or lease_until<now()) order by next_attempt_at,id for update skip locked limit 1;
 if not found then return null;end if;
 update crm_private.automation_emails set attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,now()),lease_token=gen_random_uuid(),lease_until=now()+interval '60 seconds' where id=d.id returning * into d;
 return jsonb_build_object('id',d.id,'recipient',d.recipient,'kind',d.kind,'counts',d.counts,'lease_token',d.lease_token);
end $function$
;

CREATE OR REPLACE FUNCTION crm_private.worker_claim()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.crm_jobs;
begin
 perform set_config('crm.actor_kind','worker',true); perform set_config('crm.operation','tasks.claim',true);
 -- Expired final attempt must become a durable failure rather than stay running forever.
 update public.crm_jobs set state='failed',error=jsonb_build_object('code','TEMPORARY_FAILURE','message','Worker lease expired after final attempt','retryable',false),lease_until=null,lease_token=null where user_id=(select owner_id from crm_private.settings) and state='running' and lease_until<now() and attempts>=3;
 insert into public.push_deliveries(user_id,crm_job_id,subscription_id)
 select j.user_id,j.id,s.id from public.crm_jobs j join public.push_subscriptions s on s.user_id=j.user_id and s.active where j.user_id=(select owner_id from crm_private.settings) and j.state in ('completed','failed') and j.updated_at>s.updated_at on conflict(crm_job_id,subscription_id) do nothing;
 select * into r from public.crm_jobs where user_id=(select owner_id from crm_private.settings) and attempts<3 and next_attempt_at<=now() and (state='queued' or (state='running' and lease_until<now())) order by next_attempt_at,created_at,id for update skip locked limit 1;
 if not found then return null; end if;
 perform set_config('crm.request_id',r.request_id::text,true);
 update public.crm_jobs set state='running',attempts=attempts+1,lease_until=now()+interval '60 seconds',lease_token=gen_random_uuid() where id=r.id returning * into r;
 return to_jsonb(r);
end $function$
;

CREATE OR REPLACE FUNCTION crm_private.push_claim()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d public.push_deliveries; s public.push_subscriptions;
begin
 update public.push_deliveries set state='failed',lease_until=null,lease_token=null where state='queued' and (attempts>=3 or not exists(select 1 from public.push_subscriptions active_device where active_device.user_id=push_deliveries.user_id and active_device.id=push_deliveries.subscription_id and active_device.active)) and (lease_until is null or lease_until<now());
 select pd.* into d from public.push_deliveries pd join public.push_subscriptions ps on ps.id=pd.subscription_id and ps.user_id=pd.user_id and ps.active where pd.user_id=(select owner_id from crm_private.settings) and pd.state='queued' and pd.attempts<3 and pd.next_attempt_at<=now() and (pd.lease_until is null or pd.lease_until<now()) order by pd.next_attempt_at,pd.id for update of pd skip locked limit 1;
 if not found then return null; end if;
 update public.push_deliveries set attempts=attempts+1,lease_until=now()+interval '60 seconds',lease_token=gen_random_uuid() where id=d.id returning * into d;
 select * into s from public.push_subscriptions where user_id=d.user_id and id=d.subscription_id;
 return jsonb_build_object('id',d.id,'lease_token',d.lease_token,'task_id',d.crm_job_id,'endpoint',s.endpoint,'p256dh',s.p256dh,'auth',s.auth);
end $function$
;

CREATE OR REPLACE FUNCTION crm_private.install_schedule()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 if not exists(select 1 from pg_available_extensions where name='pg_cron') or not exists(select 1 from pg_available_extensions where name='pg_net') then raise exception 'pg_cron and pg_net are required'; end if;
 execute 'create extension if not exists pg_cron';
 execute 'create extension if not exists pg_net with schema extensions';
 if to_regclass('vault.decrypted_secrets') is null then raise exception 'Vault is required'; end if;
 if not exists(select 1 from vault.decrypted_secrets where name='crm_worker_secret') or not exists(select 1 from vault.decrypted_secrets where name='crm_functions_url') then raise exception 'Provision worker scheduler Vault secrets first'; end if;
 perform cron.schedule('crm-worker','* * * * *',$job$
  select net.http_post(url:=(select decrypted_secret from vault.decrypted_secrets where name='crm_functions_url')||'/worker',headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='crm_worker_secret')),body:='{}'::jsonb,timeout_milliseconds:=60000);
 $job$);
 perform cron.schedule('crm-push','* * * * *',$job$
  select net.http_post(url:=(select decrypted_secret from vault.decrypted_secrets where name='crm_functions_url')||'/push',headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='crm_worker_secret')),body:='{}'::jsonb,timeout_milliseconds:=30000);
 $job$);
 perform crm_private.schedule_retention();
end $function$
;

CREATE OR REPLACE FUNCTION crm_private.jobs_page(owner uuid, input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare result jsonb;items jsonb;
begin
 result=crm_private.jobs_page_before_triage(owner,input);
 if result ? 'error' then return result;end if;
 select coalesce(jsonb_agg(item||jsonb_build_object('triage',crm_private.job_triage(owner,(item->>'id')::uuid) #- '{jev,criteria}') order by n),'[]'::jsonb)
 into items from jsonb_array_elements(result->'items') with ordinality as rows(item,n);
 return jsonb_set(result,'{items}',items);
end $function$
;

CREATE OR REPLACE FUNCTION crm_private.validate_explanation(s jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare k text;e jsonb;begin
 if jsonb_typeof(s) is distinct from 'object' or not s ?& array['explanation_es','explanation_en','coverage','evidence'] or s-array['explanation_es','explanation_en','coverage','evidence']<>'{}'
 or coalesce(s->>'coverage','') not in ('supported','partial','unknown','conflicting') then perform crm_private.fail('VALIDATION_ERROR','Incomplete explanation');end if;
 foreach k in array array['explanation_es','explanation_en'] loop
  if jsonb_typeof(s->k) is distinct from 'string' or length(trim(s->>k)) not between 1 and 8000 then perform crm_private.fail('VALIDATION_ERROR','Bounded explanation required');end if;
 end loop;
 if jsonb_typeof(s->'evidence') is distinct from 'array' or jsonb_array_length(s->'evidence')>8 or (s->>'coverage'='supported' and jsonb_array_length(s->'evidence')=0) then perform crm_private.fail('VALIDATION_ERROR','Inspected evidence required');end if;
 for e in select value from jsonb_array_elements(s->'evidence') loop
  if jsonb_typeof(e) is distinct from 'object' or not e ?& array['url','quote','checked_at'] or e-array['url','quote','checked_at']<>'{}'
   or jsonb_typeof(e->'url') is distinct from 'string' or e->>'url' !~ '^https?://[^[:space:]]+$'
   or jsonb_typeof(e->'quote') is distinct from 'string' or length(trim(e->>'quote')) not between 1 and 3000
   or jsonb_typeof(e->'checked_at') is distinct from 'string' or e->>'checked_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' then perform crm_private.fail('VALIDATION_ERROR','Invalid source evidence');end if;
  perform (e->>'checked_at')::timestamptz;
 end loop;
end $function$
;

CREATE OR REPLACE FUNCTION crm_private.validate_entity(entity text, input jsonb, creating boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
 perform crm_private.validate(input,crm_private.editable(entity));
 if input ? 'company_id' and input->'company_id'='null'::jsonb and entity in ('jobs','contacts') then perform crm_private.fail('VALIDATION_ERROR','Company is required','company_id'); end if;
 if input ? 'job_id' and input->'job_id'='null'::jsonb and entity='interviews' then perform crm_private.fail('VALIDATION_ERROR','Job is required','job_id'); end if;
 if entity='sources' and input ? 'kind' and input->>'kind' not in ('ats','recruiter','referral','aggregator','manual') then perform crm_private.fail('VALIDATION_ERROR','Invalid source kind','kind'); end if;
 if entity='contacts' and input ? 'status' and input->>'status' not in ('uncontacted','invited','connected','messaged','replied','interview','no_response') then perform crm_private.fail('VALIDATION_ERROR','Invalid contact status','status'); end if;
 if entity='verifications' and input ? 'status' and input->>'status' not in ('pending','partial','confirmed','ambiguous','closed') then perform crm_private.fail('VALIDATION_ERROR','Invalid verification status','status'); end if;
 if entity='outreach_events' then
  if input ? 'state' and input->>'state' not in ('draft','queued','sent','failed','responded','cancelled') then perform crm_private.fail('VALIDATION_ERROR','Invalid outreach state','state'); end if;
  if input ? 'kind' and input->>'kind' not in ('application','invitation','message','followup','response') then perform crm_private.fail('VALIDATION_ERROR','Invalid outreach kind','kind'); end if;
  if input ? 'channel' and input->>'channel' not in ('manual','email','linkedin') then perform crm_private.fail('VALIDATION_ERROR','Invalid outreach channel','channel'); end if;
 end if;
 if entity='interviews' and input ? 'state' and input->>'state' not in ('planned','completed','cancelled') then perform crm_private.fail('VALIDATION_ERROR','Invalid interview state','state'); end if;

 if creating then
  perform crm_private.required(input,case entity when 'companies' then array['name'] when 'sources' then array['name','kind'] when 'jobs' then array['company_id','title'] when 'contacts' then array['company_id','name'] when 'outreach_events' then array['channel','kind','body'] when 'interviews' then array['job_id','state','timezone'] when 'resumes' then array['label','storage_path','checksum','media_type'] when 'verifications' then array['status','checked_at','notes'] else array[]::text[] end);
 end if;
 if entity='interviews' and input ? 'timezone' and not exists(select 1 from pg_catalog.pg_timezone_names where name=input->>'timezone' and input->>'timezone' !~ '^(posix|right)/' and input->>'timezone'<>'Factory') then perform crm_private.fail('VALIDATION_ERROR','Invalid IANA timezone','timezone'); end if;
 if entity='verifications' and creating and ((input->>'job_id' is null)=(input->>'company_id' is null)) then perform crm_private.fail('VALIDATION_ERROR','Choose exactly one job or company','job_id'); end if;
 if entity='outreach_events' and creating and input->>'job_id' is null and input->>'contact_id' is null then perform crm_private.fail('VALIDATION_ERROR','Choose a contact or job','job_id'); end if;
end $function$
;

CREATE OR REPLACE FUNCTION crm_private.guard_record()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare x uuid;
begin
 if TG_OP='UPDATE' then
  if new.id<>old.id or new.user_id<>old.user_id or new.created_at<>old.created_at then raise exception using errcode='22023', message='Immutable identity'; end if;
  if TG_TABLE_NAME in ('verifications','audit_events','mutation_receipts','legacy_links') then raise exception using errcode='22023',message='Append-only record'; end if;
  if TG_TABLE_NAME='resumes' and (to_jsonb(new)-array['active','updated_at','version'])<>(to_jsonb(old)-array['active','updated_at','version']) then raise exception using errcode='22023',message='Immutable resume'; end if;
  new.version=old.version+1; new.updated_at=now();
 end if;
 if TG_TABLE_NAME='interviews' then
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=new.timezone and new.timezone !~ '^(posix|right)/' and new.timezone<>'Factory') then raise exception using errcode='22023',message='Invalid timezone'; end if;
  foreach x in array new.interviewer_ids loop
   if not exists(select 1 from public.contacts where id=x and user_id=new.user_id) then raise exception using errcode='23503',message='Invalid interviewer reference'; end if;
  end loop;
 end if;
 return new;
end $function$
;

CREATE OR REPLACE FUNCTION crm_private.validate_automation_policy_before_flows(p jsonb, owner uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare x jsonb;k text;allowed text[]=array['enabled','interval_hours','revalidate_hours','timezone','profiles','sources','model','effort','candidates_per_profile','exa_per_run_usd','exa_daily_usd','exa_monthly_usd','digest_email','closure_email'];begin
 if jsonb_typeof(p) is distinct from 'object' or not p ?& allowed or exists(select 1 from jsonb_object_keys(p) f where not f=any(allowed)) then perform crm_private.fail('VALIDATION_ERROR','Incomplete or unknown policy fields');end if;
 foreach k in array array['enabled','digest_email','closure_email'] loop if jsonb_typeof(p->k)<>'boolean' then perform crm_private.fail('VALIDATION_ERROR','Expected boolean',k);end if;end loop;
 foreach k in array array['interval_hours','revalidate_hours','candidates_per_profile','exa_per_run_usd','exa_daily_usd','exa_monthly_usd'] loop if jsonb_typeof(p->k)<>'number' then perform crm_private.fail('VALIDATION_ERROR','Expected numeric allowance',k);end if;end loop;
 if (p->>'interval_hours')::numeric not between 2 and 168 or (p->>'revalidate_hours')::numeric not between 24 and 168 or (p->>'candidates_per_profile')::numeric not between 1 and 10 or (p->>'interval_hours') !~ '^\d+$' or (p->>'revalidate_hours') !~ '^\d+$' or (p->>'candidates_per_profile') !~ '^\d+$' then perform crm_private.fail('VALIDATION_ERROR','Invalid cadence/candidate cap');end if;
 if (p->>'exa_per_run_usd')::numeric not between 0 and 2 or (p->>'exa_daily_usd')::numeric not between 0 and 100 or (p->>'exa_monthly_usd')::numeric not between 0 and 1000 then perform crm_private.fail('VALIDATION_ERROR','Invalid allowance');end if;
 if not exists(select 1 from pg_timezone_names where name=p->>'timezone' and p->>'timezone' !~ '^(posix|right)/' and p->>'timezone'<>'Factory') or jsonb_typeof(p->'model')<>'string' or length(p->>'model') not between 1 and 100 or p->>'effort' not in ('low','medium','high') then perform crm_private.fail('VALIDATION_ERROR','Model/effort/timezone required');end if;
 if jsonb_typeof(p->'sources')<>'array' or jsonb_array_length(p->'sources') not between 1 and 3 or exists(select 1 from jsonb_array_elements_text(p->'sources') s where s not in ('autoapply','openhire','exa')) or (select count(distinct value) from jsonb_array_elements(p->'sources'))<>jsonb_array_length(p->'sources') then perform crm_private.fail('VALIDATION_ERROR','Invalid sources');end if;
 if p->'sources' ? 'exa' and ((p->>'exa_per_run_usd')::numeric<=0 or (p->>'exa_daily_usd')::numeric<=0 or (p->>'exa_monthly_usd')::numeric<=0) then perform crm_private.fail('VALIDATION_ERROR','Exa needs recurring allowances');end if;
 if jsonb_typeof(p->'profiles')<>'array' or jsonb_array_length(p->'profiles') not between 1 and 8 or (select count(distinct value->>'id') from jsonb_array_elements(p->'profiles'))<>jsonb_array_length(p->'profiles') then perform crm_private.fail('VALIDATION_ERROR','Invalid profile inventory');end if;
 for x in select value from jsonb_array_elements(p->'profiles') loop
 if not x ?& array['id','resume_id','checksum','country','track','authorized_country','remote','terms','exclusions','allow_unknown_salary','salary_min','currency','salary_period'] or exists(select 1 from jsonb_object_keys(x) f where not f=any(array['id','resume_id','checksum','country','track','authorized_country','remote','terms','exclusions','allow_unknown_salary','salary_min','currency','salary_period'])) then perform crm_private.fail('VALIDATION_ERROR','Unknown/incomplete profile');end if;
 if x->>'country' not in ('MX','PE') or x->>'track' not in ('ai','general','backend','frontend') or x->>'id' is distinct from (x->>'track')||'-'||(x->>'country') or x->'authorized_country' is distinct from 'true'::jsonb or x->'remote' is distinct from 'true'::jsonb or jsonb_typeof(x->'allow_unknown_salary')<>'boolean' then perform crm_private.fail('VALIDATION_ERROR','Confirm country authorization and remote profile');end if;
 if jsonb_typeof(x->'terms')<>'array' or jsonb_array_length(x->'terms') not between 1 and 12 or jsonb_typeof(x->'exclusions')<>'array' or jsonb_array_length(x->'exclusions')>20 or exists(select 1 from jsonb_array_elements((x->'terms')||(x->'exclusions')) s where jsonb_typeof(s)<>'string' or length(s#>>'{}') not between 1 and 200) then perform crm_private.fail('VALIDATION_ERROR','Explicit bounded search terms required');end if;
 if x->'salary_min'<>'null'::jsonb and (jsonb_typeof(x->'salary_min')<>'number' or (x->>'salary_min')::numeric<0 or x->>'currency' !~ '^[A-Z]{3}$' or x->>'salary_period' not in ('hour','month','year') or x->>'currency' is null or x->>'salary_period' is null) then perform crm_private.fail('VALIDATION_ERROR','Explicit salary currency/period required');end if;
 if not exists(select 1 from public.resumes r where r.user_id=owner and r.id=(x->>'resume_id')::uuid and r.active and r.checksum=x->>'checksum' and lower(r.track)=x->>'track' and r.country=case x->>'country' when 'MX' then 'Mexico' else 'Peru' end) then perform crm_private.fail('VALIDATION_ERROR','Current owned CV does not match profile');end if;
 end loop;
end $function$
;
