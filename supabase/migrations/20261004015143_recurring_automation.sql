-- Durable owner operations. The executor has owner OAuth, never a database worker key.
create table public.automation_policies (
 user_id uuid primary key references auth.users(id), version bigint not null default 1 check(version>0),
 policy jsonb not null, updated_at timestamptz not null default now(),
 heartbeat_at timestamptz, executor_id uuid, executor_status text, next_digest_at timestamptz not null default now()+interval '1 day'
);
create table public.automation_profiles (
 user_id uuid not null references public.automation_policies(user_id), id text not null,
 resume_id uuid not null, criteria jsonb not null, next_due_at timestamptz not null default now(),
 next_revalidation_at timestamptz not null default now(), primary key(user_id,id),
 foreign key(user_id,resume_id) references public.resumes(user_id,id)
);
create table public.automation_work (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.automation_policies(user_id),
 profile_id text not null,policy_version bigint not null,kind text not null check(kind in ('discovery','revalidate','research','prepare','interview')),
 state text not null default 'queued' check(state in ('queued','running','waiting','completed','failed','blocked','cancelled')),
 job_id uuid,version bigint not null default 1 check(version>0),attempts integer not null default 0,
 next_attempt_at timestamptz not null default now(),lease_token uuid,lease_until timestamptz,executor_id uuid,
 checkpoint jsonb not null default '{}',error text,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(user_id,id),
 foreign key(user_id,job_id) references public.jobs(user_id,id)
);
create index automation_work_due on public.automation_work(user_id,next_attempt_at,id) where state in ('queued','waiting','running');
create unique index automation_one_discovery on public.automation_work(user_id,profile_id) where kind='discovery' and state in ('queued','waiting','running');
create table public.automation_packs (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),job_id uuid not null,resume_id uuid not null,
 version bigint not null,job_version bigint not null,resume_version bigint not null,company_version bigint not null,
 content jsonb not null,model text not null,effort text not null,created_at timestamptz not null default now(),
 unique(user_id,job_id,version), foreign key(user_id,job_id) references public.jobs(user_id,id),foreign key(user_id,resume_id) references public.resumes(user_id,id)
);
create table public.automation_reservations (
 id uuid primary key,user_id uuid not null references auth.users(id),work_id uuid not null,
 reserved_usd numeric not null check(reserved_usd>0),reported_usd numeric,created_at timestamptz not null default now(),
 foreign key(user_id,work_id) references public.automation_work(user_id,id)
);
create table public.automation_events (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),job_id uuid not null,profile_id text not null,
 kind text not null check(kind in ('discovered','prepared','closed')),created_at timestamptz not null default now(),
 unique(user_id,job_id,kind),foreign key(user_id,job_id) references public.jobs(user_id,id)
);
create table crm_private.automation_emails (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),window_key text not null,kind text not null,
 recipient text not null,counts jsonb not null,state text not null default 'queued' check(state in ('queued','accepted','failed','cancelled')),
 attempts integer not null default 0,first_attempt_at timestamptz,next_attempt_at timestamptz not null default now(),
 lease_token uuid,lease_until timestamptz,provider_email_id uuid,unique(user_id,window_key)
);
alter table crm_private.automation_emails enable row level security;
revoke all on crm_private.automation_emails from public,anon,authenticated,crm_worker;
do $$ declare t text; begin
 foreach t in array array['automation_policies','automation_profiles','automation_work','automation_packs','automation_reservations','automation_events'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
 execute format('create policy owner_read on public.%I for select to authenticated using (user_id=(select auth.uid()) and (select crm_private.is_owner()))',t);
 end loop;
end $$;
create index automation_packs_job on public.automation_packs(user_id,job_id,version desc);
create index automation_events_window on public.automation_events(user_id,created_at);
create index automation_reservations_budget on public.automation_reservations(user_id,created_at);
create index automation_work_job on public.automation_work(user_id,job_id);
create index automation_profiles_resume on public.automation_profiles(user_id,resume_id);
create index automation_packs_resume on public.automation_packs(user_id,resume_id);

create function crm_private.validate_automation_policy(p jsonb,owner uuid) returns void language plpgsql set search_path='' as $$
declare x jsonb;k text;allowed text[]=array['enabled','interval_hours','revalidate_hours','timezone','profiles','sources','model','effort','candidates_per_profile','exa_per_run_usd','exa_daily_usd','exa_monthly_usd','digest_email','closure_email'];begin
 if jsonb_typeof(p) is distinct from 'object' or not p ?& allowed or exists(select 1 from jsonb_object_keys(p) f where not f=any(allowed)) then perform crm_private.fail('VALIDATION_ERROR','Incomplete or unknown policy fields');end if;
 foreach k in array array['enabled','digest_email','closure_email'] loop if jsonb_typeof(p->k)<>'boolean' then perform crm_private.fail('VALIDATION_ERROR','Expected boolean',k);end if;end loop;
 foreach k in array array['interval_hours','revalidate_hours','candidates_per_profile','exa_per_run_usd','exa_daily_usd','exa_monthly_usd'] loop if jsonb_typeof(p->k)<>'number' then perform crm_private.fail('VALIDATION_ERROR','Expected numeric allowance',k);end if;end loop;
 if (p->>'interval_hours')::numeric not between 2 and 168 or (p->>'revalidate_hours')::numeric not between 24 and 168 or (p->>'candidates_per_profile')::numeric not between 1 and 10 or (p->>'interval_hours') !~ '^\d+$' or (p->>'revalidate_hours') !~ '^\d+$' or (p->>'candidates_per_profile') !~ '^\d+$' then perform crm_private.fail('VALIDATION_ERROR','Invalid cadence/candidate cap');end if;
 if (p->>'exa_per_run_usd')::numeric not between 0 and 2 or (p->>'exa_daily_usd')::numeric not between 0 and 100 or (p->>'exa_monthly_usd')::numeric not between 0 and 1000 then perform crm_private.fail('VALIDATION_ERROR','Invalid allowance');end if;
 if not exists(select 1 from pg_timezone_names where name=p->>'timezone') or jsonb_typeof(p->'model')<>'string' or length(p->>'model') not between 1 and 100 or p->>'effort' not in ('low','medium','high') then perform crm_private.fail('VALIDATION_ERROR','Model/effort/timezone required');end if;
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
end $$;
revoke all on function crm_private.validate_automation_policy(jsonb,uuid) from public,anon,authenticated;

create function crm_private.validate_automation_pack(p jsonb) returns void language plpgsql set search_path='' as $$
declare x jsonb;k text;allowed text[]=array['introduction_es','introduction_en','questions','employer_questions_es','employer_questions_en','gaps','english_required','interview_language','company_facts','predictions','practice_completed'];begin
 if jsonb_typeof(p) is distinct from 'object' or not p ?& allowed or p-allowed<>'{}' or p->'predictions' is distinct from 'true'::jsonb or p->'practice_completed' is distinct from 'false'::jsonb then perform crm_private.fail('VALIDATION_ERROR','Complete predicted bilingual pack required');end if;
 foreach k in array array['introduction_es','introduction_en'] loop if jsonb_typeof(p->k)<>'string' or length(p->>k)>5000 then perform crm_private.fail('VALIDATION_ERROR','Invalid introduction');end if;end loop;
 if p->'english_required' not in ('true'::jsonb,'false'::jsonb,'null'::jsonb) or p->'interview_language' not in ('"es"'::jsonb,'"en"'::jsonb,'null'::jsonb) then perform crm_private.fail('VALIDATION_ERROR','Unknown language must remain null');end if;
 foreach k in array array['employer_questions_es','employer_questions_en','gaps'] loop
  if jsonb_typeof(p->k)<>'array' or jsonb_array_length(p->k)>(case when k='gaps' then 20 else 8 end) or exists(select 1 from jsonb_array_elements(p->k) a where jsonb_typeof(a)<>'string' or length(a#>>'{}')>2000) then perform crm_private.fail('VALIDATION_ERROR','Invalid question/gap list');end if;
 end loop;
 if jsonb_array_length(p->'employer_questions_es')<>jsonb_array_length(p->'employer_questions_en') then perform crm_private.fail('VALIDATION_ERROR','Question translations must align');end if;
 if jsonb_typeof(p->'questions')<>'array' or jsonb_array_length(p->'questions') not between 3 and 12 then perform crm_private.fail('VALIDATION_ERROR','Three to twelve bilingual questions required');end if;
 for x in select value from jsonb_array_elements(p->'questions') loop
  if jsonb_typeof(x)<>'object' or not x ?& array['question_es','question_en','answer_es','answer_en','cv_evidence'] or x-array['question_es','question_en','answer_es','answer_en','cv_evidence']<>'{}' then perform crm_private.fail('VALIDATION_ERROR','Incomplete question');end if;
  foreach k in array array['question_es','question_en','answer_es','answer_en','cv_evidence'] loop
   if jsonb_typeof(x->k)<>'string' or length(x->>k)>(case when k like 'question_%' then 2000 when k='cv_evidence' then 3000 else 5000 end) or (k like 'question_%' or k='cv_evidence') and length(x->>k)=0 then perform crm_private.fail('VALIDATION_ERROR','Question/CV evidence missing');end if;
  end loop;
 end loop;
 if jsonb_typeof(p->'company_facts')<>'array' or jsonb_array_length(p->'company_facts')>20 then perform crm_private.fail('VALIDATION_ERROR','Invalid company facts');end if;
 for x in select value from jsonb_array_elements(p->'company_facts') loop
  if x-array['fact','url']<>'{}' or jsonb_typeof(x->'fact')<>'string' or length(x->>'fact')>3000 or jsonb_typeof(x->'url')<>'string' or x->>'url' !~ '^https?://' then perform crm_private.fail('VALIDATION_ERROR','Sourced facts required');end if;
 end loop;
end $$;
revoke all on function crm_private.validate_automation_pack(jsonb) from public,anon,authenticated;

create function crm_private.automation_operation(owner uuid,op text,input jsonb) returns jsonb language plpgsql set search_path='' as $$
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
    update public.automation_work set state='failed',error='RETRY_LIMIT',lease_token=null,lease_until=null,version=version+1,updated_at=now() where user_id=owner and attempts>=3 and (state='waiting' or state='running' and lease_until<now()) and checkpoint->>'provider_id' is null;
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
revoke all on function crm_private.automation_operation(uuid,text,jsonb) from public,anon,authenticated;
create or replace function public.crm_operation(p_operation text,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then return jsonb_build_object('error',jsonb_build_object('code','UNAUTHENTICATED','message','Sign in to continue','retryable',false));end if;
 if not crm_private.is_owner() and exists(select 1 from crm_private.settings where owner_id=auth.uid()) then return jsonb_build_object('error',jsonb_build_object('code','UNAUTHENTICATED','message','Session revoked','retryable',false));end if;
 if p_operation like 'automation.%' then return crm_private.automation_operation(auth.uid(),p_operation,p_input);end if;
 if p_operation='jobs.list' then return crm_private.jobs_page(auth.uid(),p_input);end if;
 return crm_private.operation(auth.uid(),p_operation,p_input);
exception when sqlstate 'CR001' then return jsonb_build_object('error',SQLERRM::jsonb);
 when invalid_text_representation then return jsonb_build_object('error',jsonb_build_object('code','UNAUTHENTICATED','message','Invalid session','retryable',false));
end $$;

create function crm_private.automation_email_claim() returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.automation_policies;d crm_private.automation_emails;counts jsonb;window_start timestamptz;window_end timestamptz;begin
 select * into p from public.automation_policies where user_id=(select owner_id from crm_private.settings) for update;
 if p.user_id is null then return null;end if;
 if (p.policy->>'digest_email')::boolean and p.next_digest_at<=now() then
  window_end=date_trunc('day',now() at time zone (p.policy->>'timezone')) at time zone (p.policy->>'timezone');window_start=(date_trunc('day',now() at time zone (p.policy->>'timezone'))-interval '1 day') at time zone (p.policy->>'timezone');
  select jsonb_build_object('new',(select count(distinct job_id) from public.automation_events where user_id=p.user_id and kind='discovered' and created_at>=window_start and created_at<window_end),'prepared',(select count(distinct job_id) from public.automation_events where user_id=p.user_id and kind='prepared' and created_at>=window_start and created_at<window_end),'closed',(select count(distinct job_id) from public.automation_events where user_id=p.user_id and kind='closed' and created_at>=window_start and created_at<window_end),'incomplete',(select count(*) from public.automation_work where user_id=p.user_id and state in ('failed','blocked') and updated_at>=window_start and updated_at<window_end)) into counts;
  insert into crm_private.automation_emails(user_id,window_key,kind,recipient,counts) select p.user_id,'digest/'||window_end::text,'digest',email,counts from auth.users where id=p.user_id on conflict do nothing;
  update public.automation_policies set next_digest_at=(date_trunc('day',now() at time zone (p.policy->>'timezone'))+interval '1 day') at time zone (p.policy->>'timezone') where user_id=p.user_id;
 end if;
 update crm_private.automation_emails set state='cancelled',lease_token=null,lease_until=null where user_id=p.user_id and state='queued' and not (case kind when 'digest' then (p.policy->>'digest_email')::boolean else (p.policy->>'closure_email')::boolean end);
 update crm_private.automation_emails set state='failed',lease_token=null,lease_until=null where user_id=p.user_id and state='queued' and (attempts>=3 or first_attempt_at<now()-interval '23 hours') and (lease_until is null or lease_until<now());
 select * into d from crm_private.automation_emails where user_id=p.user_id and state='queued' and next_attempt_at<=now() and (lease_until is null or lease_until<now()) order by next_attempt_at,id for update skip locked limit 1;
 if not found then return null;end if;
 update crm_private.automation_emails set attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,now()),lease_token=gen_random_uuid(),lease_until=now()+interval '60 seconds' where id=d.id returning * into d;
 return jsonb_build_object('id',d.id,'recipient',d.recipient,'kind',d.kind,'counts',d.counts,'lease_token',d.lease_token);
end $$;
create function crm_private.automation_email_authorize(delivery uuid,token uuid) returns boolean language sql security definer set search_path='' as $$
 select exists(select 1 from crm_private.automation_emails d join public.automation_policies p on p.user_id=d.user_id where d.user_id=(select owner_id from crm_private.settings) and d.id=delivery and d.state='queued' and d.lease_token=token and d.lease_until>now() and d.first_attempt_at>now()-interval '23 hours' and (case d.kind when 'digest' then (p.policy->>'digest_email')::boolean else (p.policy->>'closure_email')::boolean end));
$$;
create function crm_private.automation_email_finish(delivery uuid,token uuid,status integer,provider_id uuid default null) returns void language plpgsql security definer set search_path='' as $$
declare d crm_private.automation_emails;begin
 select * into d from crm_private.automation_emails where user_id=(select owner_id from crm_private.settings) and id=delivery for update;
 if not found or d.state<>'queued' or d.lease_token is distinct from token or d.lease_until<=now() then perform crm_private.fail('FORBIDDEN','Email lease required');end if;
 if status between 200 and 299 and provider_id is null then perform crm_private.fail('VALIDATION_ERROR','Provider ID required');end if;
 update crm_private.automation_emails set state=case when status=-1 then 'cancelled' when status between 200 and 299 then 'accepted' when status in (0,429) or status>=500 then case when attempts<3 and first_attempt_at>now()-interval '23 hours' then 'queued' else 'failed' end else 'failed' end,provider_email_id=case when status between 200 and 299 then provider_id end,lease_token=null,lease_until=null,next_attempt_at=now()+interval '30 seconds' where id=d.id;
end $$;
revoke all on function crm_private.automation_email_claim(),crm_private.automation_email_authorize(uuid,uuid),crm_private.automation_email_finish(uuid,uuid,integer,uuid) from public,anon,authenticated;
grant execute on function crm_private.automation_email_claim(),crm_private.automation_email_authorize(uuid,uuid),crm_private.automation_email_finish(uuid,uuid,integer,uuid) to crm_worker;
