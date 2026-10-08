-- Owner notification history shares the existing guarded automation transaction.
alter table public.automation_work add column cycle_id uuid, add column parent_work_id uuid;
alter table public.automation_work add foreign key(user_id,parent_work_id) references public.automation_work(user_id,id);
create index automation_work_parent on public.automation_work(user_id,parent_work_id);
create table public.notification_state(user_id uuid primary key references auth.users(id),version bigint not null default 1,live_email boolean not null default false,disclosure text not null default 'generic' check(disclosure in ('generic','vacancy_summary')));
create table public.notification_batches(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),window_start timestamptz not null,window_end timestamptz not null,version bigint not null default 1,read_at timestamptz,updated_at timestamptz not null default now(),created_at timestamptz not null default now(),unique(user_id,id),unique(user_id,window_start));
create index notification_batches_page on public.notification_batches(user_id,created_at desc,id desc);
alter table public.automation_events drop constraint automation_events_user_id_job_id_kind_key;
alter table public.automation_events drop constraint automation_events_kind_check;
alter table public.automation_events add constraint automation_events_kind_check check(kind in ('discovered','prepared','closed','updated','contacts','company'));
alter table public.automation_events add column mutation_id uuid,add column work_id uuid,add column cycle_id uuid,add column job_version bigint,add column snapshot jsonb,add column batch_id uuid;
alter table public.automation_events add foreign key(user_id,batch_id) references public.notification_batches(user_id,id);
create unique index automation_events_change on public.automation_events(user_id,mutation_id,job_id,kind) where mutation_id is not null;
create index automation_events_batch on public.automation_events(user_id,batch_id,job_id,created_at,id);
alter table crm_private.automation_emails add column batch_id uuid,add column disclosure text not null default 'generic',add column content jsonb,add column request jsonb,add column request_body text,add column legacy boolean not null default true;
do $$ declare t text;begin
 foreach t in array array['notification_state','notification_batches'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
 execute format('create policy owner_read on public.%I for select to authenticated using(user_id=(select auth.uid()) and (select crm_private.is_owner()))',t);
 end loop;
end $$;

create function crm_private.notification_work_origin() returns trigger language plpgsql set search_path='' as $$
declare parent uuid=nullif(current_setting('crm.notification_work',true),'')::uuid;begin
 new.parent_work_id=parent;
 if parent is not null then select cycle_id into new.cycle_id from public.automation_work where user_id=new.user_id and id=parent;end if;
 new.cycle_id=coalesce(new.cycle_id,nullif(current_setting('crm.notification_cycle',true),'')::uuid,gen_random_uuid());return new;
end $$;
create trigger notification_work_origin before insert on public.automation_work for each row execute function crm_private.notification_work_origin();

create function crm_private.notification_event(owner uuid,job uuid,kind text,changes jsonb) returns void language plpgsql set search_path='' as $$
declare w public.automation_work;b public.notification_batches;j public.jobs;company text;mutation uuid;start_at timestamptz;begin
 select * into w from public.automation_work where user_id=owner and id=nullif(current_setting('crm.notification_work',true),'')::uuid;
 if w.id is null then return;end if;
 mutation=nullif(current_setting('crm.notification_mutation',true),'')::uuid;
 if mutation is null then return;end if;
 if exists(select 1 from public.automation_events where user_id=owner and mutation_id=mutation and job_id=job and automation_events.kind=notification_event.kind) then return;end if;
 select * into j from public.jobs where user_id=owner and id=job;
 if j.id is null then return;end if;
 select name into company from public.companies where user_id=owner and id=j.company_id;
 start_at=date_bin(interval '15 minutes',clock_timestamp(),'2000-01-01'::timestamptz);
 insert into public.notification_state(user_id) values(owner) on conflict do nothing;
 insert into public.notification_batches(user_id,window_start,window_end) values(owner,start_at,start_at+interval '15 minutes') on conflict(user_id,window_start) do update set version=notification_batches.version+1,read_at=null,updated_at=clock_timestamp() returning * into b;
 insert into public.automation_events(user_id,job_id,profile_id,kind,mutation_id,work_id,cycle_id,job_version,snapshot,batch_id,created_at)
 values(owner,job,w.profile_id,kind,mutation,w.id,w.cycle_id,j.version,jsonb_build_object('title',left(j.title,500),'company',left(company,500),'changes',changes),b.id,clock_timestamp());
 update public.notification_state set version=version+1 where user_id=owner;
end $$;

create function crm_private.notification_capture() returns trigger language plpgsql set search_path='' as $$
declare changes jsonb='{}';k text;j public.jobs;before jsonb;after jsonb;url text;begin
 if nullif(current_setting('crm.notification_work',true),'') is null then return new;end if;
 if tg_table_name='jobs' then
  if tg_op='INSERT' then perform crm_private.notification_event(new.user_id,new.id,'discovered','{}');return new;end if;
  foreach k in array array['title','location','salary_text','salary_min','salary_max','currency','posting_url','stage'] loop
   before=to_jsonb(old)->k;after=to_jsonb(new)->k;
   if jsonb_typeof(before)='string' then before=to_jsonb(left(before#>>'{}',2000));end if;
   if jsonb_typeof(after)='string' then after=to_jsonb(left(after#>>'{}',2000));end if;
   if before is distinct from after then changes=changes||jsonb_build_object(k,jsonb_build_object('before',before,'after',after));end if;
  end loop;
  if old.description_summary is distinct from new.description_summary then changes=changes||jsonb_build_object('description_updated',true);end if;
  if changes<>'{}' then
   k='updated';
   if old.stage<>new.stage and new.stage='archived' and old.stage in ('radar','review','ready') and old.applied_at is null then
    select evidence_url into url from public.verifications where user_id=new.user_id and job_id=new.id and status='closed' and evidence_url is not null and checked_at>now()-interval '24 hours' order by checked_at desc limit 1;
    if url is not null then k='closed';changes=changes||jsonb_build_object('reason','Publicación original confirmada como cerrada','evidence_url',url);end if;
   end if;
   perform crm_private.notification_event(new.user_id,new.id,k,changes);
  end if;
 elsif tg_table_name='contacts' then
  if new.job_id is not null and new.linkedin_url is not null and (tg_op='INSERT' or old.job_id is distinct from new.job_id or old.linkedin_url is distinct from new.linkedin_url) then
   perform crm_private.notification_event(new.user_id,new.job_id,'contacts',case when tg_op='INSERT' or old.job_id is distinct from new.job_id or old.linkedin_url is null then jsonb_build_object('verified_contacts_added',1) else jsonb_build_object('contact_information_updated',true) end);
  end if;
 elsif tg_table_name='companies' then
  if tg_op='UPDATE' and (old.name is distinct from new.name or old.product is distinct from new.product or old.website_url is distinct from new.website_url) then
   for j in select * from public.jobs where user_id=new.user_id and company_id=new.id loop
    perform crm_private.notification_event(new.user_id,j.id,'company',jsonb_build_object('company_information_updated',true));
   end loop;
  end if;
 elsif tg_table_name='automation_packs' then
  if not exists(select 1 from public.automation_packs p where p.user_id=new.user_id and p.job_id=new.job_id and p.id<>new.id and p.content=new.content and p.job_version=new.job_version and p.resume_version=new.resume_version and p.company_version=new.company_version) then
   perform crm_private.notification_event(new.user_id,new.job_id,'prepared',jsonb_build_object('preparation_version',new.version,'review_gaps',jsonb_array_length(new.content->'gaps')));
  end if;
 end if;return new;
end $$;
create trigger notification_jobs after insert or update on public.jobs for each row execute function crm_private.notification_capture();
create trigger notification_contacts after insert or update on public.contacts for each row execute function crm_private.notification_capture();
create trigger notification_companies after update on public.companies for each row execute function crm_private.notification_capture();
create trigger notification_packs after insert on public.automation_packs for each row execute function crm_private.notification_capture();

-- Remove superseded count-only emission, keeping every existing guard and effect receipt.
do $$ declare definition text;lines text[];line text;updated text='';removed integer=0;begin
 definition=pg_get_functiondef('crm_private.automation_operation(uuid,text,jsonb)'::regprocedure);
 foreach line in array string_to_array(definition,E'\n') loop
  if line like '%insert into public.automation_events%' or line like '%if (p.policy->>''closure_email'')::boolean then insert into crm_private.automation_emails%' then removed=removed+1;
  else updated=updated||line||E'\n';end if;
 end loop;
 if removed<>4 then raise exception 'Unexpected event dispatcher; review upgrade';end if;
 execute updated;
end $$;
alter function crm_private.automation_operation(uuid,text,jsonb) rename to automation_operation_before_notifications;
create function crm_private.automation_operation(owner uuid,op text,input jsonb) returns jsonb language plpgsql set search_path='' as $$
declare result jsonb;begin
 perform set_config('crm.notification_mutation',coalesce(input->>'idempotency_key',''),true);
 perform set_config('crm.notification_cycle',coalesce(input->>'idempotency_key',''),true);
 perform set_config('crm.notification_work',case when op in ('automation.commit','automation.pack.save','automation.checkpoint') then coalesce(input->>'work_id','') else '' end,true);
 result=crm_private.automation_operation_before_notifications(owner,op,input);
 perform set_config('crm.notification_work','',true);perform set_config('crm.notification_mutation','',true);perform set_config('crm.notification_cycle','',true);
 return result;
end $$;
revoke all on function crm_private.automation_operation(uuid,text,jsonb),crm_private.notification_event(uuid,uuid,text,jsonb),crm_private.notification_capture(),crm_private.notification_work_origin() from public,anon,authenticated;

create function crm_private.notification_batch(b public.notification_batches) returns jsonb language sql set search_path='' as $$
 select to_jsonb(b)||jsonb_build_object('vacancies',(select count(distinct job_id) from public.automation_events where user_id=b.user_id and batch_id=b.id),'open',b.window_end>now(),'delivery',coalesce((select state from crm_private.automation_emails where user_id=b.user_id and batch_id=b.id order by first_attempt_at desc nulls last limit 1),'not_queued'),'delivery_verified',false);
$$;
create function crm_private.notification_items(owner uuid,batch uuid,job uuid default null,after_job uuid default null,maximum integer default 50) returns jsonb language sql set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('job_id',x.job_id,'events',x.events) order by x.job_id),'[]'::jsonb) from (
 select e.job_id,jsonb_agg(jsonb_build_object('id',e.id,'kind',e.kind,'created_at',e.created_at,'job_version',e.job_version,'profile_id',e.profile_id,'cycle_id',e.cycle_id,'work_id',e.work_id,'snapshot',e.snapshot) order by e.created_at,e.id) events
 from public.automation_events e where e.user_id=owner and e.batch_id=batch and (job is null or e.job_id=job) and (after_job is null or e.job_id>after_job) group by e.job_id order by e.job_id limit maximum) x;
$$;
create function crm_private.notification_operation(owner uuid,op text,input jsonb) returns jsonb language plpgsql set search_path='' as $$
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
 perform crm_private.required(input,array['idempotency_key','expected_version']);key=(input->>'idempotency_key')::uuid;hash=encode(extensions.digest(op||input::text,'sha256'),'hex');
 select * into receipt from public.mutation_receipts where user_id=owner and idempotency_key=key;
 if found then if receipt.operation<>op or receipt.payload_hash<>hash then perform crm_private.fail('IDEMPOTENCY_CONFLICT','Changed request identity');end if;return receipt.response;end if;
 insert into public.notification_state(user_id) values(owner) on conflict do nothing;
 if op='notifications.read' then
  if input-array['idempotency_key','expected_version','id','read']<>'{}' or jsonb_typeof(input->'read')<>'boolean' then perform crm_private.fail('VALIDATION_ERROR','Guarded read input required');end if;
  select * into b from public.notification_batches where user_id=owner and id=(input->>'id')::uuid for update;
  if b.id is null then perform crm_private.fail('NOT_FOUND','Notification unavailable');end if;
  if b.version<>(input->>'expected_version')::bigint then perform crm_private.fail('CONFLICT','Notification changed','expected_version',b.version);end if;
  update public.notification_batches set read_at=case when (input->>'read')::boolean then now() end,version=version+1 where user_id=owner and id=b.id returning * into b;
  update public.notification_state set version=version+1 where user_id=owner;
  result=crm_private.notification_batch(b);
 elsif op in ('notifications.mark_all','notifications.configure') then
  if s.version<>(input->>'expected_version')::bigint then perform crm_private.fail('CONFLICT','Notification state changed','expected_version',s.version);end if;
  if op='notifications.mark_all' then
   if input-array['idempotency_key','expected_version','cutoff']<>'{}' or not input ? 'cutoff' then perform crm_private.fail('VALIDATION_ERROR','Cutoff required');end if;
   cutoff=(input->>'cutoff')::timestamptz;if cutoff>now() then perform crm_private.fail('VALIDATION_ERROR','Future cutoff');end if;
   update public.notification_batches set read_at=now(),version=version+1 where user_id=owner and updated_at<=cutoff and read_at is null;
  else
   if input-array['idempotency_key','expected_version','live_email','disclosure']<>'{}' or jsonb_typeof(input->'live_email')<>'boolean' or input->>'disclosure' not in ('generic','vacancy_summary') then perform crm_private.fail('VALIDATION_ERROR','Explicit disclosure and live preference required');end if;
   update public.notification_state set live_email=(input->>'live_email')::boolean,disclosure=input->>'disclosure' where user_id=owner;
  end if;
  update public.notification_state set version=version+1 where user_id=owner returning * into s;result=to_jsonb(s);
 else perform crm_private.fail('VALIDATION_ERROR','Unknown notification operation');end if;
 insert into public.mutation_receipts(user_id,idempotency_key,operation,payload_hash,response) values(owner,key,op,hash,result);return result;
exception when sqlstate 'CR001' then return jsonb_build_object('error',SQLERRM::jsonb);
 when invalid_text_representation or invalid_parameter_value or check_violation or not_null_violation then return jsonb_build_object('error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid notification input','retryable',false));
end $$;
revoke all on function crm_private.notification_operation(uuid,text,jsonb),crm_private.notification_batch(public.notification_batches),crm_private.notification_items(uuid,uuid,uuid,uuid,integer) from public,anon,authenticated;
do $$ declare definition text;marker text=' if p_operation like ''automation.%'' then';begin
 definition=pg_get_functiondef('public.crm_operation(text,jsonb)'::regprocedure);
 if strpos(definition,marker)=0 then raise exception 'Unexpected owner dispatcher';end if;
 execute replace(definition,marker,' if p_operation like ''notifications.%'' then return crm_private.notification_operation(auth.uid(),p_operation,p_input);end if;'||E'\n'||marker);
end $$;

create function crm_private.notification_prune() returns void language plpgsql security definer set search_path='' as $$
begin
 update public.automation_events set snapshot=null where created_at<now()-interval '90 days' and snapshot is not null;
 update crm_private.automation_emails set state=case when state='queued' then 'failed' else state end,content=null,request=null,request_body=null where coalesce(first_attempt_at,(content->>'window_end')::timestamptz)<now()-interval '90 days' and (content is not null or request is not null or request_body is not null);
end $$;
revoke all on function crm_private.notification_prune() from public,anon,authenticated;
grant execute on function crm_private.notification_prune() to crm_worker;

create function crm_private.notification_day_window(clock timestamptz,tz text) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('end',date_trunc('day',clock at time zone tz) at time zone tz,'start',(date_trunc('day',clock at time zone tz)-interval '1 day') at time zone tz);
$$;
revoke all on function crm_private.notification_day_window(timestamptz,text) from public,anon,authenticated;
-- Rolling upgrades and rollback: an old sender can claim only old-format messages.
alter function crm_private.automation_email_claim() rename to automation_email_claim_legacy;
do $$ declare definition text;begin
 definition=pg_get_functiondef('crm_private.automation_email_claim_legacy()'::regprocedure);
 definition=replace(definition,'where user_id=p.user_id and state=','where user_id=p.user_id and legacy and state=');
 execute definition;
end $$;
create function crm_private.automation_email_claim() returns jsonb language sql security definer set search_path='' as $$select crm_private.automation_email_claim_legacy();$$;
revoke all on function crm_private.automation_email_claim() from public,anon,authenticated;
grant execute on function crm_private.automation_email_claim() to crm_worker;
create function crm_private.automation_email_claim_v2() returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.automation_policies;s public.notification_state;d crm_private.automation_emails;b public.notification_batches;items jsonb;counts jsonb;start_at timestamptz;end_at timestamptz;begin
 perform pg_advisory_xact_lock(hashtextextended((select owner_id::text from crm_private.settings),0));
 select * into p from public.automation_policies where user_id=(select owner_id from crm_private.settings) for update;
 if p.user_id is null then return null;end if;

 perform crm_private.notification_prune();
 insert into public.notification_state(user_id) values(p.user_id) on conflict do nothing;
 select * into s from public.notification_state where user_id=p.user_id;
 for b in select * from public.notification_batches where user_id=p.user_id and window_end<=now() and window_end>now()-interval '24 hours' and not exists(select 1 from crm_private.automation_emails where user_id=p.user_id and batch_id=notification_batches.id) order by window_start loop
  if s.live_email or ((p.policy->>'closure_email')::boolean and exists(select 1 from public.automation_events where user_id=p.user_id and batch_id=b.id and kind='closed')) then
   items=crm_private.notification_items(p.user_id,b.id,null,null,50);
   select jsonb_build_object('new',count(distinct job_id) filter(where kind='discovered'),'prepared',count(distinct job_id) filter(where kind='prepared'),'closed',count(distinct job_id) filter(where kind='closed'),'vacancies',count(distinct job_id),'incomplete',(select count(*) from public.automation_work where user_id=p.user_id and state in ('waiting','blocked','failed'))) into counts from public.automation_events where user_id=p.user_id and batch_id=b.id;
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
end $$;
create or replace function crm_private.automation_email_authorize(delivery uuid,token uuid) returns boolean language sql security definer set search_path='' as $$
 select exists(select 1 from crm_private.automation_emails d join public.automation_policies p on p.user_id=d.user_id left join public.notification_state s on s.user_id=d.user_id where d.user_id=(select owner_id from crm_private.settings) and d.id=delivery and d.state='queued' and d.lease_token=token and d.lease_until>now() and d.first_attempt_at>now()-interval '23 hours' and coalesce(case d.kind when 'digest' then (p.policy->>'digest_email')::boolean when 'updates' then s.live_email else (p.policy->>'closure_email')::boolean end,false) and (d.disclosure='generic' or s.disclosure='vacancy_summary'));
$$;
create function crm_private.automation_email_freeze(delivery uuid,token uuid,payload jsonb,payload_body text default null) returns text language plpgsql security definer set search_path='' as $$
declare d crm_private.automation_emails;begin
 select * into d from crm_private.automation_emails where user_id=(select owner_id from crm_private.settings) and id=delivery for update;
 if not crm_private.automation_email_authorize(delivery,token) then perform crm_private.fail('FORBIDDEN','Delivery permission revoked');end if;
 if d.request_body is not null then return d.request_body;end if;
 payload_body=coalesce(payload_body,payload::text);
 if payload_body::jsonb is distinct from payload or octet_length(payload_body)>262144 then perform crm_private.fail('VALIDATION_ERROR','Invalid immutable bytes');end if;
 if jsonb_typeof(payload)<>'object' or octet_length(payload::text)>262144 or payload-array['from','to','subject','text','html']<>'{}' or payload->'to' is distinct from jsonb_build_array(d.recipient) then perform crm_private.fail('VALIDATION_ERROR','Invalid immutable email');end if;
 update crm_private.automation_emails set request=payload,request_body=payload_body where id=d.id;return payload_body;
end $$;
revoke all on function crm_private.automation_email_freeze(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function crm_private.automation_email_freeze(uuid,uuid,jsonb,text) to crm_worker;

-- Existing events contain real timestamps but no detailed snapshot or origin.
insert into public.notification_batches(user_id,window_start,window_end,created_at,updated_at)
select user_id,date_bin(interval '15 minutes',created_at,'2000-01-01'::timestamptz),date_bin(interval '15 minutes',created_at,'2000-01-01'::timestamptz)+interval '15 minutes',min(created_at),max(created_at) from public.automation_events where batch_id is null group by user_id,date_bin(interval '15 minutes',created_at,'2000-01-01'::timestamptz) on conflict do nothing;
update public.automation_events e set batch_id=b.id from public.notification_batches b where e.user_id=b.user_id and e.batch_id is null and e.created_at>=b.window_start and e.created_at<b.window_end;
update crm_private.automation_emails d set batch_id=e.batch_id from public.automation_events e where d.user_id=e.user_id and d.window_key='closed/'||e.job_id and e.kind='closed' and d.batch_id is null;
do $$ begin
 if to_regprocedure('cron.schedule(text,text,text)') is not null then perform cron.schedule('crm-notification-retention','18 3 * * *','select crm_private.notification_prune();');end if;
end $$;

revoke all on function crm_private.automation_email_claim_v2() from public,anon,authenticated;
grant execute on function crm_private.automation_email_claim_v2() to crm_worker;
