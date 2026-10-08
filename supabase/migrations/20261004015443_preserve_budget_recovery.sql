-- Budget waits do not exhaust crash retries; accepted research still polls the same ID.
create or replace function crm_private.automation_operation(owner uuid,op text,input jsonb) returns jsonb language plpgsql set search_path='' as $$
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
   'work',coalesce((select jsonb_agg(to_jsonb(t)-'checkpoint'||jsonb_build_object('checkpoint',jsonb_build_object('phase',t.checkpoint->'phase','counts',t.checkpoint->'counts','gaps',t.checkpoint->'gaps')) order by t.created_at desc) from (select * from public.automation_work where user_id=owner order by created_at desc limit 50) t),'[]'::jsonb),
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
  delete from public.automation_profiles where user_id=owner and not exists(select 1 from jsonb_array_elements(p.policy->'profiles') x where x->>'id'=automation_profiles.id);
  update public.automation_work set state='cancelled',updated_at=now(),version=version+1 where user_id=owner and policy_version<>p.version and state in ('queued','waiting','blocked') and not (kind='research' and checkpoint->>'provider_id' is not null);
  if not (p.policy->>'digest_email')::boolean then update crm_private.automation_emails set state='cancelled' where user_id=owner and kind='digest' and state='queued';end if;
  if not (p.policy->>'closure_email')::boolean then update crm_private.automation_emails set state='cancelled' where user_id=owner and kind='closed' and state='queued';end if;
  result=jsonb_build_object('version',p.version,'policy',p.policy);
 elsif op in ('automation.claim','automation.trigger') then
  if p.user_id is null then perform crm_private.fail('VALIDATION_ERROR','Configure automation first');end if;
  if input-(case when op='automation.claim' then array['idempotency_key','executor_id'] else array['idempotency_key','profile_id'] end)<>'{}' then perform crm_private.fail('VALIDATION_ERROR','Unknown trigger/claim input');end if;
  if op='automation.trigger' and not (p.policy->>'enabled')::boolean then perform crm_private.fail('FORBIDDEN','Automation is paused');end if;
  if (p.policy->>'enabled')::boolean then
   for pr in select * from public.automation_profiles where user_id=owner and (next_due_at<=now() or op='automation.trigger') and (input->>'profile_id' is null or id=input->>'profile_id') for update loop
    select * into w from public.automation_work where user_id=owner and profile_id=pr.id and kind='discovery' and state in ('queued','running','waiting') limit 1;
    if not found then insert into public.automation_work(user_id,profile_id,policy_version,kind,checkpoint) values(owner,pr.id,p.version,'discovery',jsonb_build_object('phase','discover','profile',pr.criteria)) returning * into w;end if;
    ids=ids||jsonb_build_array(w.id);
    update public.automation_profiles set next_due_at=now()+make_interval(hours=>(p.policy->>'interval_hours')::int) where user_id=owner and id=pr.id;
   end loop;
   -- Refresh preparations for actual upcoming interviews before bulk radar work.
   for rowjob in select distinct j.* from public.jobs j join public.interviews i on i.user_id=j.user_id and i.job_id=j.id where j.user_id=owner and i.state='planned' and i.scheduled_at>=now() and not exists(select 1 from public.automation_work q where q.user_id=owner and q.job_id=j.id and q.kind='interview' and q.state in ('queued','running','waiting','blocked')) and not exists(select 1 from public.automation_packs k where k.user_id=owner and k.job_id=j.id and k.job_version=j.version and k.resume_id=j.resume_id and k.created_at>now()-interval '24 hours') loop
    select * into pr from public.automation_profiles where user_id=owner order by (resume_id=rowjob.resume_id) desc nulls last,id limit 1;
    if found then insert into public.automation_work(user_id,profile_id,policy_version,kind,job_id,checkpoint) values(owner,pr.id,p.version,'interview',rowjob.id,jsonb_build_object('phase','interview-refresh','needs_profile',rowjob.resume_id is distinct from pr.resume_id));end if;
   end loop;
   -- Existing radar is first-class work, including legacy jobs without a CV mapping.
   for rowjob in select * from public.jobs j where j.user_id=owner and j.stage='radar' and not exists(select 1 from public.automation_work q where q.user_id=owner and q.job_id=j.id and q.kind in ('research','prepare','interview') and (q.state in ('queued','running','waiting','blocked','failed') or q.state='completed' and q.checkpoint->>'phase'='finished')) order by j.created_at,j.id loop
    select * into pr from public.automation_profiles where user_id=owner order by (resume_id=rowjob.resume_id) desc nulls last,id limit 1;
    if found then
     insert into public.automation_work(user_id,profile_id,policy_version,kind,job_id,checkpoint) values(owner,pr.id,p.version,case when rowjob.resume_id=pr.resume_id and rowjob.posting_url is not null and p.policy->'sources' ? 'exa' then 'research' else 'prepare' end,rowjob.id,jsonb_build_object('phase','radar-backlog','needs_profile',rowjob.resume_id is distinct from pr.resume_id));
    end if;
   end loop;
   for pr in select * from public.automation_profiles where user_id=owner and next_revalidation_at<=now() for update loop
    if not exists(select 1 from public.automation_work where user_id=owner and profile_id=pr.id and kind='revalidate' and state in ('queued','running','waiting')) then
     insert into public.automation_work(user_id,profile_id,policy_version,kind,checkpoint) values(owner,pr.id,p.version,'revalidate',jsonb_build_object('phase','revalidate','profile',pr.criteria));
    end if;
    update public.automation_profiles set next_revalidation_at=now()+make_interval(hours=>(p.policy->>'revalidate_hours')::int) where user_id=owner and id=pr.id;
   end loop;
  end if;
  if op='automation.trigger' then result=jsonb_build_object('work_ids',ids);
  else
   if exists(select 1 from public.automation_work where user_id=owner and state='running' and lease_until>now()) then result=jsonb_build_object('work',null);
   else
    update public.automation_work set state='failed',error='RETRY_LIMIT',lease_token=null,lease_until=null,version=version+1,updated_at=now() where user_id=owner and attempts>=3 and (state='waiting' or state='running' and lease_until<now()) and checkpoint->>'provider_id' is null and checkpoint->>'phase' is distinct from 'budget-wait';
    select * into w from public.automation_work where user_id=owner and next_attempt_at<=now() and ((state in ('queued','waiting') or (state='running' and lease_until<now())) and (policy_version=p.version and (p.policy->>'enabled')::boolean or kind='research' and checkpoint->>'provider_id' is not null)) order by case kind when 'interview' then 0 when 'research' then 1 when 'prepare' then 2 when 'discovery' then 3 else 4 end,next_attempt_at,id for update skip locked limit 1;
    if not found then result=jsonb_build_object('work',null);
    else update public.automation_work set state='running',lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes',executor_id=(input->>'executor_id')::uuid,attempts=attempts+1,version=version+1,updated_at=now() where id=w.id returning * into w;result=jsonb_build_object('work',to_jsonb(w));end if;
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
  if op not in ('automation.checkpoint') and (w.policy_version<>p.version or not (p.policy->>'enabled')::boolean) then perform crm_private.fail('FORBIDDEN','Policy paused or changed');end if;
  if op='automation.checkpoint' then
   if input-array['idempotency_key','work_id','lease_token','expected_version','state','checkpoint','next_attempt_at','error','children']<>'{}' or input->>'state' not in ('running','waiting','completed','failed','blocked','cancelled') or jsonb_typeof(input->'checkpoint')<>'object' or jsonb_typeof(input->'children')<>'array' or jsonb_array_length(input->'children')>20 then perform crm_private.fail('VALIDATION_ERROR','Invalid checkpoint');end if;
   if (w.policy_version<>p.version or not (p.policy->>'enabled')::boolean) and jsonb_array_length(input->'children')>0 then perform crm_private.fail('FORBIDDEN','Changed policy cannot create work');end if;
   if input->'checkpoint' ? 'reported_usd' then
    amount=(input->'checkpoint'->>'reported_usd')::numeric;if amount<0 then perform crm_private.fail('VALIDATION_ERROR','Invalid reported cost');end if;
    update public.automation_reservations set reported_usd=amount where user_id=owner and work_id=w.id and id=(input->'checkpoint'->>'request_id')::uuid;
   end if;
   update public.automation_work set checkpoint=input->'checkpoint',state=input->>'state',error=input->>'error',next_attempt_at=coalesce((input->>'next_attempt_at')::timestamptz,now()),version=version+1,updated_at=now(),lease_token=case when input->>'state'='running' then lease_token end,lease_until=case when input->>'state'='running' then lease_until end where id=w.id returning * into w;
   for x in select value from jsonb_array_elements(input->'children') loop
    if x->>'kind' not in ('discovery','revalidate','research','prepare','interview') or jsonb_typeof(x->'checkpoint')<>'object' then perform crm_private.fail('VALIDATION_ERROR','Invalid child');end if;
    if not exists(select 1 from public.automation_profiles where user_id=owner and id=coalesce(x->>'profile_id',w.profile_id)) then perform crm_private.fail('FORBIDDEN','Unknown child profile');end if;
    if exists(select 1 from public.automation_work where id=(x->>'id')::uuid and (user_id<>owner or job_id is distinct from (x->>'job_id')::uuid or profile_id<>coalesce(x->>'profile_id',w.profile_id))) then perform crm_private.fail('IDEMPOTENCY_CONFLICT','Child identity differs');end if;
    insert into public.automation_work(id,user_id,profile_id,policy_version,kind,job_id,checkpoint) values((x->>'id')::uuid,owner,coalesce(x->>'profile_id',w.profile_id),p.version,x->>'kind',(x->>'job_id')::uuid,x->'checkpoint') on conflict(id) do nothing;
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
   r=crm_private.operation(owner,input->>'operation',input->'input');if r ? 'error' then perform crm_private.fail(r->'error'->>'code',r->'error'->>'message',r->'error'->>'field',(r->'error'->>'current_version')::bigint);end if;
   if input->>'operation'='jobs.upsert' and not input->'input' ? 'id' then insert into public.automation_events(user_id,job_id,profile_id,kind) values(owner,(r->>'id')::uuid,w.profile_id,'discovered') on conflict do nothing;end if;
   if input->>'operation'='jobs.transition' and input->'input'->>'stage'='archived' then
    insert into public.automation_events(user_id,job_id,profile_id,kind) values(owner,(oldjob->>'id')::uuid,w.profile_id,'closed') on conflict do nothing;
    if (p.policy->>'closure_email')::boolean then insert into crm_private.automation_emails(user_id,window_key,kind,recipient,counts) select owner,'closed/'||(oldjob->>'id'),'closed',email,'{"closed":1}'::jsonb from auth.users where id=owner on conflict do nothing;end if;
   end if;
   result=jsonb_build_object('result',r);
  elsif op='automation.pack.save' then
   if input-array['idempotency_key','work_id','lease_token','expected_version','job_id','resume_id','job_version','resume_version','expected_pack_version','content','model','effort']<>'{}' then perform crm_private.fail('VALIDATION_ERROR','Unknown pack fields');end if;
   if w.kind not in ('prepare','interview') or w.job_id is distinct from (input->>'job_id')::uuid then perform crm_private.fail('FORBIDDEN','Pack belongs to claimed preparation');end if;
   select * into rowjob from public.jobs where user_id=owner and id=(input->>'job_id')::uuid;
   select * into resume from public.resumes where user_id=owner and id=(input->>'resume_id')::uuid and active;
   select * into company from public.companies where user_id=owner and id=rowjob.company_id;
   if rowjob.id is null or resume.id is null or rowjob.version<>(input->>'job_version')::bigint or resume.version<>(input->>'resume_version')::bigint then perform crm_private.fail('CONFLICT','Pack inputs changed');end if;
   select coalesce(max(version),0) into v from public.automation_packs where user_id=owner and job_id=rowjob.id;
   if v<>(input->>'expected_pack_version')::bigint then perform crm_private.fail('CONFLICT','Pack changed','expected_pack_version',v);end if;
   if input->'content'->'predictions' is distinct from 'true'::jsonb or input->'content'->'practice_completed' is distinct from 'false'::jsonb or jsonb_typeof(input->'content'->'questions')<>'array' or jsonb_array_length(input->'content'->'questions') not between 3 and 12 then perform crm_private.fail('VALIDATION_ERROR','Pack must contain predicted bilingual questions, not completed events');end if;
   perform crm_private.validate_automation_pack(input->'content');
   if input->>'effort' not in ('low','medium','high') or length(input->>'model') not between 1 and 100 then perform crm_private.fail('VALIDATION_ERROR','Invalid model/effort');end if;
   insert into public.automation_packs(user_id,job_id,resume_id,version,job_version,resume_version,company_version,content,model,effort) values(owner,rowjob.id,resume.id,v+1,rowjob.version,resume.version,company.version,input->'content',input->>'model',input->>'effort') returning * into pk;
   insert into public.automation_events(user_id,job_id,profile_id,kind) values(owner,rowjob.id,w.profile_id,'prepared') on conflict do nothing;
   result=jsonb_build_object('pack',to_jsonb(pk),'stale',false);
  end if;
 end if;
 insert into public.mutation_receipts(user_id,idempotency_key,operation,payload_hash,response) values(owner,key,op,hash,result);
 return result;
exception when sqlstate 'CR001' then return jsonb_build_object('error',SQLERRM::jsonb);
 when invalid_text_representation or check_violation or not_null_violation or foreign_key_violation or numeric_value_out_of_range then return jsonb_build_object('error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid automation input','retryable',false));
end $$;
