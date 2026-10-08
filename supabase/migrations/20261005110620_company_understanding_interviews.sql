-- Forward-compatible company explanations and durable invitation intent.
alter table public.interviews add column language text check(language in ('es','en'));
alter table public.interviews add column format text check(format in ('hr','technical','system_design','product','manager','other'));
create table public.automation_company_guides (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id), company_id uuid not null,
 version bigint not null check(version>0), company_version bigint not null, content jsonb not null,
 source_fingerprint text not null check(source_fingerprint ~ '^[a-f0-9]{64}$'), work_id uuid not null,
 created_at timestamptz not null default now(), unique(user_id,company_id,version),
 foreign key(user_id,company_id) references public.companies(user_id,id),
 foreign key(user_id,work_id) references public.automation_work(user_id,id)
);
create table public.automation_interview_intents (
 user_id uuid not null references auth.users(id), job_id uuid not null, active boolean not null default true,
 origin text not null, preparation_context jsonb not null default '[]', revision text not null,
 requested_at timestamptz not null default now(), primary key(user_id,job_id),
 foreign key(user_id,job_id) references public.jobs(user_id,id)
);
create index automation_guides_work on public.automation_company_guides(user_id,work_id);
create index automation_guides_latest on public.automation_company_guides(user_id,company_id,version desc);
create unique index automation_one_interview_v2 on public.automation_work(user_id,job_id)
 where kind='interview' and checkpoint->>'content_version'='2' and state in ('queued','running','waiting','blocked');
do $$ declare t text;begin
 foreach t in array array['automation_company_guides','automation_interview_intents'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('create policy owner_read on public.%I for select to authenticated using (user_id=(select auth.uid()) and (select crm_private.is_owner()))',t);
 end loop;
end $$;

alter function crm_private.editable(text) rename to editable_before_interview_context;
create function crm_private.editable(entity text) returns text[] language sql immutable set search_path='' as $$
 select crm_private.editable_before_interview_context(entity)||case when entity='interviews' then array['language','format'] else array[]::text[] end;
$$;
revoke all on function crm_private.editable(text) from public,anon,authenticated;

create function crm_private.interview_context(owner uuid,job uuid) returns jsonb language sql stable set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version,'state',state,'scheduled_at',scheduled_at,'timezone',timezone,
 'interviewer_ids',interviewer_ids,'language',language,'format',format) order by scheduled_at nulls last,id),'[]')
 from (select * from public.interviews where user_id=owner and job_id=job and state='planned' order by scheduled_at nulls last,id limit 20) i;
$$;
-- Version changes from unrelated interview notes do not purchase more research.
create function crm_private.interview_revision(owner uuid,job uuid,context jsonb) returns text language sql stable set search_path='' as $$
 select encode(extensions.digest(jsonb_build_object('rounds',(select coalesce(jsonb_agg(v-'version'),'[]') from jsonb_array_elements(crm_private.interview_context(owner,job)) v),'context',context,
 'posting',j.posting_url,'title',j.title,'description',j.description_summary,'resume_id',j.resume_id)::text,'sha256'),'hex') from public.jobs j where user_id=owner and id=job;
$$;
create function crm_private.enqueue_interview(owner uuid,job uuid,origin text,context jsonb default null,manual boolean default false) returns uuid language plpgsql set search_path='' as $$
declare p public.automation_policies;pr public.automation_profiles;j public.jobs;w public.automation_work;i public.automation_interview_intents;rev text;begin
 perform pg_advisory_xact_lock(hashtextextended(owner::text,0));
 select * into j from public.jobs where user_id=owner and id=job;
 if not found then perform crm_private.fail('NOT_FOUND','Vacancy not found');end if;
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
 select * into w from public.automation_work where user_id=owner and job_id=job and kind='interview' and checkpoint->>'content_version'='2' and state in ('queued','running','waiting','blocked') for update limit 1;
 if found then
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
 and k.job_version=j.version and k.resume_version=r.version and r.active and k.company_version=c.version) then return null;end if;
 insert into public.automation_work(user_id,profile_id,policy_version,kind,job_id,checkpoint)
 values(owner,pr.id,p.version,'interview',job,jsonb_build_object('content_version',2,'phase','evidence-review')||case when manual then '{"on_demand_scope":"interview"}'::jsonb else '{}'::jsonb end) returning id into w.id;
 return w.id;
end $$;
create function crm_private.capture_interview_intent() returns trigger language plpgsql set search_path='' as $$
begin
 if auth.uid() is distinct from new.user_id or not crm_private.is_owner() then return new;end if;
 if tg_table_name='jobs' then
  if current_setting('crm.operation',true) in ('jobs.transition','jobs.upsert') and new.stage='interview'
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
end $$;
create trigger interview_invitation after insert or update on public.jobs for each row execute function crm_private.capture_interview_intent();
create trigger interview_round after insert or update on public.interviews for each row execute function crm_private.capture_interview_intent();

create function crm_private.validate_explanation(s jsonb) returns void language plpgsql set search_path='' as $$
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
   or jsonb_typeof(e->'checked_at') is distinct from 'string' or e->>'checked_at' !~ '^\d{4}-\d{2}-\d{2}T' then perform crm_private.fail('VALIDATION_ERROR','Invalid source evidence');end if;
  perform (e->>'checked_at')::timestamptz;
 end loop;
end $$;
create function crm_private.validate_company_guide(g jsonb) returns void language plpgsql set search_path='' as $$
declare k text;begin
 if jsonb_typeof(g) is distinct from 'object' or not g ?& array['depth','offering','customers','revenue','workflow','technology','hiring_process','example','example_kind','gaps','review_status']
 or g-array['depth','offering','customers','revenue','workflow','technology','hiring_process','example','example_kind','gaps','review_status']<>'{}'
 or coalesce(g->>'depth','') not in ('initial','application','interview') or coalesce(g->>'example_kind','') not in ('published','illustrative','unknown')
 or g->>'review_status' is distinct from 'needs_review' then perform crm_private.fail('VALIDATION_ERROR','Complete company guide required');end if;
 foreach k in array array['offering','customers','revenue','workflow','technology','hiring_process','example'] loop perform crm_private.validate_explanation(g->k);end loop;
 if jsonb_typeof(g->'gaps') is distinct from 'array' or jsonb_array_length(g->'gaps')>20 or exists(select 1 from jsonb_array_elements(g->'gaps') v where jsonb_typeof(v)<>'string' or length(v#>>'{}') not between 1 and 2000) then perform crm_private.fail('VALIDATION_ERROR','Invalid guide gaps');end if;
end $$;
alter function crm_private.validate_automation_pack(jsonb) rename to validate_automation_pack_v1;
create function crm_private.validate_automation_pack(p jsonb) returns void language plpgsql set search_path='' as $$
declare x jsonb;k text;extra text[]=array['content_version','depth','coverage','company_guide','guide_version','role_guide','rounds','context_revision','communication'];begin
 if not p ? 'content_version' then perform crm_private.validate_automation_pack_v1(p);return;end if;
 if not p ?& extra or p->>'content_version'<>'2' or coalesce(p->>'depth','') not in ('application','interview') or coalesce(p->>'coverage','') not in ('partial','supported') then perform crm_private.fail('VALIDATION_ERROR','Invalid pack version/depth');end if;
 perform crm_private.validate_automation_pack_v1(p-extra);
 perform crm_private.validate_company_guide(p->'company_guide');
 if jsonb_typeof(p->'role_guide') is distinct from 'object' or not p->'role_guide' ?& array['area','contribution','requirements'] or (p->'role_guide')-array['area','contribution','requirements']<>'{}' then perform crm_private.fail('VALIDATION_ERROR','Role explanation required');end if;
 perform crm_private.validate_explanation(p->'role_guide'->'area');perform crm_private.validate_explanation(p->'role_guide'->'contribution');
 if jsonb_typeof(p->'role_guide'->'requirements') is distinct from 'array' or jsonb_array_length(p->'role_guide'->'requirements')>20 then perform crm_private.fail('VALIDATION_ERROR','Invalid requirements');end if;
 for x in select value from jsonb_array_elements(p->'role_guide'->'requirements') loop
  if not x ?& array['requirement','cv_evidence','gap'] or x-array['requirement','cv_evidence','gap']<>'{}' or jsonb_typeof(x->'requirement') is distinct from 'string' or length(x->>'requirement') not between 1 and 2000 then perform crm_private.fail('VALIDATION_ERROR','Invalid requirement');end if;
  foreach k in array array['cv_evidence','gap'] loop if x->k<>'null'::jsonb and (jsonb_typeof(x->k)<>'string' or length(x->>k)>3000) then perform crm_private.fail('VALIDATION_ERROR','Invalid requirement evidence');end if;end loop;
 end loop;
 if p->'guide_version'<>'null'::jsonb and (p->>'guide_version' !~ '^[1-9][0-9]*$') then perform crm_private.fail('VALIDATION_ERROR','Invalid guide version');end if;
 if jsonb_typeof(p->'rounds') is distinct from 'array' or jsonb_array_length(p->'rounds')>20 or jsonb_typeof(p->'context_revision') is distinct from 'string' or length(p->>'context_revision')>64 then perform crm_private.fail('VALIDATION_ERROR','Invalid round context');end if;
 for x in select value from jsonb_array_elements(p->'rounds') loop
  if jsonb_typeof(x) is distinct from 'object' or not x ?& array['id','version','state','scheduled_at','timezone','interviewer_ids','language','format'] or x-array['id','version','state','scheduled_at','timezone','interviewer_ids','language','format']<>'{}'
   or jsonb_typeof(x->'id') is distinct from 'string' or jsonb_typeof(x->'version') is distinct from 'number' or coalesce(x->>'version','') !~ '^[1-9][0-9]*$' or coalesce(x->>'state','') not in ('planned','completed','cancelled')
   or jsonb_typeof(x->'timezone') is distinct from 'string' or length(x->>'timezone') not between 1 and 200
   or jsonb_typeof(x->'interviewer_ids') is distinct from 'array' or jsonb_array_length(x->'interviewer_ids')>100
   or (x->'language'<>'null'::jsonb and coalesce(x->>'language','') not in ('es','en'))
   or (x->'format'<>'null'::jsonb and coalesce(x->>'format','') not in ('hr','technical','system_design','product','manager','other')) then perform crm_private.fail('VALIDATION_ERROR','Invalid round');end if;
  perform (x->>'id')::uuid;
  if x->'scheduled_at'<>'null'::jsonb then perform (x->>'scheduled_at')::timestamptz;end if;
  perform value::uuid from jsonb_array_elements_text(x->'interviewer_ids');
 end loop;
 if jsonb_typeof(p->'communication') is distinct from 'object' or not p->'communication' ?& array['english_level','explain_back_es','explain_back_en','vocabulary','clarification_en','stories'] or (p->'communication')-array['english_level','explain_back_es','explain_back_en','vocabulary','clarification_en','stories']<>'{}' then perform crm_private.fail('VALIDATION_ERROR','Communication support required');end if;
 foreach k in array array['explain_back_es','explain_back_en'] loop if jsonb_typeof(p->'communication'->k)<>'string' or length(p->'communication'->>k) not between 1 and 8000 then perform crm_private.fail('VALIDATION_ERROR','Explain-back required');end if;end loop;
 foreach k in array array['vocabulary','clarification_en','stories'] loop if jsonb_typeof(p->'communication'->k)<>'array' or jsonb_array_length(p->'communication'->k)>(case k when 'stories' then 8 when 'clarification_en' then 10 else 20 end) then perform crm_private.fail('VALIDATION_ERROR','Invalid communication list');end if;end loop;
 if p->'communication'->'english_level'<>'null'::jsonb and (jsonb_typeof(p->'communication'->'english_level') is distinct from 'string' or length(p->'communication'->>'english_level')>200) then perform crm_private.fail('VALIDATION_ERROR','Invalid English level');end if;
 for x in select value from jsonb_array_elements(p->'communication'->'clarification_en') loop
  if jsonb_typeof(x) is distinct from 'string' or length(x#>>'{}') not between 1 and 1000 then perform crm_private.fail('VALIDATION_ERROR','Invalid clarification');end if;
 end loop;
 for x in select value from jsonb_array_elements(p->'communication'->'vocabulary') loop
  if jsonb_typeof(x) is distinct from 'object' or not x ?& array['term','meaning_es'] or x-array['term','meaning_es']<>'{}'
   or jsonb_typeof(x->'term') is distinct from 'string' or length(x->>'term')>200 or jsonb_typeof(x->'meaning_es') is distinct from 'string' or length(x->>'meaning_es')>1000 then perform crm_private.fail('VALIDATION_ERROR','Invalid vocabulary');end if;
 end loop;
 for x in select value from jsonb_array_elements(p->'communication'->'stories') loop
  if jsonb_typeof(x) is distinct from 'object' or not x ?& array['title','outline_es','outline_en','evidence'] or x-array['title','outline_es','outline_en','evidence']<>'{}' then perform crm_private.fail('VALIDATION_ERROR','Invalid story');end if;
  foreach k in array array['title','outline_es','outline_en','evidence'] loop
   if jsonb_typeof(x->k) is distinct from 'string' or length(x->>k) not between 1 and (case k when 'title' then 500 when 'evidence' then 3000 else 5000 end) then perform crm_private.fail('VALIDATION_ERROR','Invalid story evidence');end if;
  end loop;
 end loop;
 if jsonb_array_length(p->'employer_questions_es')<>jsonb_array_length(p->'employer_questions_en') then perform crm_private.fail('VALIDATION_ERROR','Bilingual questions must correspond');end if;
end $$;

-- Keep existing receipts, budgets, notification wrappers and manual authorization fences.
alter function crm_private.automation_operation(uuid,text,jsonb) rename to automation_operation_before_understanding;
create function crm_private.automation_operation(owner uuid,op text,input jsonb) returns jsonb language plpgsql set search_path='' as $$
declare p public.automation_policies;w public.automation_work;g public.automation_company_guides;c public.companies;i public.automation_interview_intents;
 r jsonb;receipt public.mutation_receipts;hash text;key uuid;v bigint;request_work_id uuid;x jsonb;begin
 if owner is null or owner is distinct from auth.uid() or not crm_private.is_owner() then perform crm_private.fail('FORBIDDEN','Live owner session required');end if;
 if jsonb_typeof(input) is distinct from 'object' or octet_length(input::text)>1048576 then perform crm_private.fail('VALIDATION_ERROR','Expected bounded object');end if;
 perform pg_advisory_xact_lock(hashtextextended(owner::text,0));
 if op='automation.claim' then
  for i in select * from public.automation_interview_intents where user_id=owner and active loop perform crm_private.enqueue_interview(owner,i.job_id,i.origin);end loop;
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
 when invalid_text_representation or check_violation or not_null_violation or foreign_key_violation or numeric_value_out_of_range or invalid_datetime_format then return jsonb_build_object('error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid preparation input','retryable',false));
end $$;

-- Manual interview grants have no discovery/contact side effects.
create or replace function crm_private.automation_work_enabled(policy jsonb,kind text,checkpoint jsonb) returns boolean language sql immutable set search_path='' as $$
 select case when checkpoint ? 'on_demand_scope' then coalesce(case checkpoint->>'on_demand_scope'
 when 'classification' then kind='classify' when 'discovery' then kind='discovery'
 when 'existing' then kind in ('research','prepare','interview','revalidate') when 'interview' then kind='interview' else false end,false)
 when kind='classify' then false else crm_private.automation_flow_enabled(policy,kind) end;
$$;
-- Existing legacy requests require an explicit refresh; no inferred invitation backfill.
update public.automation_work set state='blocked',error='INTERVIEW_REQUEST_REQUIRES_REVIEW',version=version+1,updated_at=now() where kind='interview' and checkpoint->>'content_version' is distinct from '2' and state in ('queued','waiting','blocked');
-- Version-2 work is claimed only by upgraded workers; accepted runs can still be retrieved.
do $upgrade$ declare definition text;begin
 definition=pg_get_functiondef('crm_private.automation_operation_before_notifications(uuid,text,jsonb)'::regprocedure);
 definition=replace(definition,$old$array['idempotency_key','executor_id']$old$,$new$array['idempotency_key','executor_id','content_version']$new$);
 definition=replace(definition,$old$where user_id=owner and next_attempt_at<=now() and$old$,$new$where user_id=owner and next_attempt_at<=now() and (checkpoint->>'content_version' is distinct from '2' or input->>'content_version'='2') and$new$);
 definition=replace(definition,$old$kind='research' and checkpoint->>'provider_id' is not null$old$,$new$kind in ('research','interview') and checkpoint->>'provider_id' is not null$new$);
 definition=replace(definition,$old$and i.scheduled_at>=now()$old$,$new$and false and i.scheduled_at>=now()$new$);
 definition=replace(definition,$old$or kind='research' and checkpoint->>'provider_id' is not null$old$,$new$or kind in ('research','interview') and checkpoint->>'provider_id' is not null$new$);
 execute definition;
end $upgrade$;
do $$ declare f regprocedure;begin
 foreach f in array array['crm_private.interview_context(uuid,uuid)'::regprocedure,'crm_private.interview_revision(uuid,uuid,jsonb)'::regprocedure,'crm_private.enqueue_interview(uuid,uuid,text,jsonb,boolean)'::regprocedure,'crm_private.capture_interview_intent()'::regprocedure,'crm_private.validate_explanation(jsonb)'::regprocedure,'crm_private.validate_company_guide(jsonb)'::regprocedure,'crm_private.validate_automation_pack(jsonb)'::regprocedure,'crm_private.automation_operation(uuid,text,jsonb)'::regprocedure] loop execute format('revoke all on function %s from public,anon,authenticated',f);end loop;
end $$;
