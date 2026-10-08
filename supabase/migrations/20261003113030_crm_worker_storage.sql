insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('resumes','resumes',false,10485760,array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document']) on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy resume_owner_read on storage.objects for select to authenticated using(bucket_id='resumes' and (storage.foldername(name))[1]=(select auth.uid())::text and (select crm_private.is_owner()));
create policy resume_owner_insert on storage.objects for insert to authenticated with check(bucket_id='resumes' and (storage.foldername(name))[1]=(select auth.uid())::text and (select crm_private.is_owner()));
-- No overwrite/delete grant: versioned uploaded CV bytes stay immutable.

create role crm_worker nologin noinherit nobypassrls;
grant usage on schema crm_private to crm_worker;
revoke all on all tables in schema public from crm_worker;
revoke all on all tables in schema crm_private from crm_worker;

create function crm_private.worker_claim() returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.crm_jobs;
begin
 perform set_config('crm.actor_kind','worker',true); perform set_config('crm.operation','tasks.claim',true);
 -- Expired final attempt must become a durable failure rather than stay running forever.
 update public.crm_jobs set state='failed',error=jsonb_build_object('code','TEMPORARY_FAILURE','message','Worker lease expired after final attempt','retryable',false),lease_until=null,lease_token=null where user_id=(select owner_id from crm_private.settings) and state='running' and lease_until<now() and attempts>=3;
 insert into public.push_deliveries(user_id,crm_job_id,subscription_id)
 select j.user_id,j.id,s.id from public.crm_jobs j join public.push_subscriptions s on s.user_id=j.user_id and s.active where j.user_id=(select owner_id from crm_private.settings) and j.state in ('completed','failed') on conflict(crm_job_id,subscription_id) do nothing;
 select * into r from public.crm_jobs where user_id=(select owner_id from crm_private.settings) and attempts<3 and next_attempt_at<=now() and (state='queued' or (state='running' and lease_until<now())) order by next_attempt_at,created_at,id for update skip locked limit 1;
 if not found then return null; end if;
 perform set_config('crm.request_id',r.request_id::text,true);
 update public.crm_jobs set state='running',attempts=attempts+1,lease_until=now()+interval '60 seconds',lease_token=gen_random_uuid() where id=r.id returning * into r;
 return to_jsonb(r);
end $$;

create function crm_private.worker_job(task uuid,token uuid) returns public.crm_jobs language plpgsql set search_path='' as $$
declare j public.crm_jobs;
begin
 select * into j from public.crm_jobs where id=task for update;
 if not found or j.state<>'running' or j.lease_token is distinct from token or j.lease_until<=now() then perform crm_private.fail('FORBIDDEN','Valid claimed task lease required'); end if;
 if not exists(select 1 from crm_private.settings where owner_id=j.user_id) then perform crm_private.fail('FORBIDDEN','Task owner is not authorized'); end if;
 return j;
end $$;

create function crm_private.worker_finish(task uuid,token uuid,result jsonb,err jsonb default null) returns void language plpgsql security definer set search_path='' as $$
declare j public.crm_jobs;
begin
 j=crm_private.worker_job(task,token);
 perform set_config('crm.actor_kind','worker',true); perform set_config('crm.request_id',j.request_id::text,true); perform set_config('crm.operation','tasks.finish',true);
 if err is not null then
  update public.crm_jobs set state=case when attempts<3 and coalesce((err->>'retryable')::boolean,false) then 'queued' else 'failed' end,error=err,lease_until=null,lease_token=null,next_attempt_at=now()+make_interval(secs=>case when attempts=1 then 5 else 30 end) where id=j.id;
 else update public.crm_jobs set state='completed',result=worker_finish.result,error=null,lease_until=null,lease_token=null where id=j.id;
 end if;
 insert into public.push_deliveries(user_id,crm_job_id,subscription_id)
 select j.user_id,j.id,s.id from public.push_subscriptions s where s.user_id=j.user_id and s.active and (select state from public.crm_jobs where id=j.id) in ('completed','failed') on conflict(crm_job_id,subscription_id) do nothing;
end $$;

create function crm_private.worker_records(task uuid,token uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.crm_jobs; item jsonb; r jsonb; items jsonb='[]';
begin
 j=crm_private.worker_job(task,token);
 if j.kind<>'embed_records' then perform crm_private.fail('VALIDATION_ERROR','Embedding task required'); end if;
 for item in select value from jsonb_array_elements(j.payload->'records') loop
  r=crm_private.record(item->>'entity_type',j.user_id,(item->>'id')::uuid);
  items=items||jsonb_build_array(jsonb_build_object('entity_type',item->>'entity_type','id',r->'id','version',r->'version','text',case item->>'entity_type' when 'jobs' then concat_ws(' ',r->>'title',r->>'description_summary',r->>'notes') when 'companies' then concat_ws(' ',r->>'name',r->>'product') else concat_ws(' ',r->>'name',r->>'role',r->>'notes') end));
 end loop;
 return items;
end $$;

create function crm_private.worker_embeddings(task uuid,token uuid,records jsonb,model text) returns void language plpgsql security definer set search_path='' as $$
declare j public.crm_jobs; item jsonb; r jsonb; v double precision[];
begin
 j=crm_private.worker_job(task,token);
 if j.kind<>'embed_records' or jsonb_typeof(records)<>'array' or jsonb_array_length(records)<>jsonb_array_length(j.payload->'records') or length(model) not between 1 and 200 then perform crm_private.fail('VALIDATION_ERROR','Embedding results do not match claimed task'); end if;
 for item in select value from jsonb_array_elements(records) loop
  if not exists(select 1 from jsonb_array_elements(j.payload->'records') e where e->>'entity_type'=item->>'entity_type' and e->>'id'=item->>'id') then perform crm_private.fail('FORBIDDEN','Embedding record was not in claimed task'); end if;
  r=crm_private.record(item->>'entity_type',j.user_id,(item->>'id')::uuid,(item->>'version')::bigint);
  select array_agg(value::text::float8 order by ordinality) into v from jsonb_array_elements(item->'vector') with ordinality;
  if (select coalesce(sum(x*x),0) from unnest(v) x)=0 or exists(select 1 from unnest(v) x where x='NaN'::float8 or abs(x)='Infinity'::float8) then perform crm_private.fail('VALIDATION_ERROR','Embedding contains nonfinite value'); end if;
  insert into crm_private.embeddings(user_id,entity_type,entity_id,vector,model,source_version) values(j.user_id,item->>'entity_type',(item->>'id')::uuid,v,model,(r->>'version')::bigint) on conflict(user_id,entity_type,entity_id) do update set vector=excluded.vector,model=excluded.model,source_version=excluded.source_version;
 end loop;
 perform crm_private.worker_finish(task,token,jsonb_build_object('embedded',jsonb_array_length(records),'model',model));
end $$;

-- Bulk import and completion commit together. Child keys remain stable across retries/batches.
create function crm_private.worker_import(task uuid,token uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.crm_jobs; item jsonb; data jsonb; entity text; linked uuid; child uuid; result jsonb; results jsonb='[]'; existing public.mutation_receipts; hash text; a uuid;
begin
 j=crm_private.worker_job(task,token);
 if j.kind<>'bulk_import' then perform crm_private.fail('VALIDATION_ERROR','Import task required'); end if;
 perform pg_advisory_xact_lock(hashtextextended(j.user_id::text,0));
 for item in select value from jsonb_array_elements(j.payload->'records') loop
  entity=item->>'entity_type'; data=item->'data';
  perform crm_private.validate(data,crm_private.editable(entity)||array['id']);
  child=md5(jsonb_build_array(j.user_id,j.payload->>'import_namespace',entity,item->>'legacy_id')::text)::uuid;
  hash=encode(extensions.digest(item::text,'sha256'),'hex'); select * into existing from public.mutation_receipts where user_id=j.user_id and idempotency_key=child;
  if found then
   if existing.operation<>'import.'||entity or existing.payload_hash<>hash then perform crm_private.fail('IDEMPOTENCY_CONFLICT','Imported legacy identity has different content'); end if;
   result=existing.response;
  else
   select entity_id into linked from public.legacy_links where user_id=j.user_id and import_namespace=j.payload->>'import_namespace' and entity_type=entity and legacy_id=item->>'legacy_id';
   if linked is not null then perform crm_private.fail('CONFLICT','Legacy identity already exists without matching receipt'); end if;
   perform set_config('crm.operation','import.'||entity,true); perform set_config('crm.request_id',child::text,true); perform set_config('crm.actor_kind','worker',true);
   result=crm_private.save(entity,j.user_id,data-'id',null,null,(data->>'id')::uuid);
   if entity='resumes' then result=result-'storage_path'; end if;
   insert into public.legacy_links(user_id,import_namespace,entity_type,legacy_id,entity_id) values(j.user_id,j.payload->>'import_namespace',entity,item->>'legacy_id',(result->>'id')::uuid);
   insert into public.mutation_receipts(user_id,idempotency_key,operation,payload_hash,response) values(j.user_id,child,'import.'||entity,hash,result);
  end if;
  results=results||jsonb_build_array(jsonb_build_object('entity_type',entity,'legacy_id',item->>'legacy_id','id',result->'id','version',result->'version','needs_review',entity='jobs' and result->>'applied_at' is null and result->>'stage' in ('applied','invited','messaged','replied','interview','offer','rejected')));
 end loop;
 perform crm_private.worker_finish(task,token,jsonb_build_object('records',results,'import_namespace',j.payload->'import_namespace'));
 return jsonb_build_object('records',results);
end $$;

create function crm_private.push_claim() returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.push_deliveries; s public.push_subscriptions;
begin
 update public.push_deliveries set state='failed',lease_until=null,lease_token=null where state='queued' and attempts>=3 and (lease_until is null or lease_until<now());
 select pd.* into d from public.push_deliveries pd join public.push_subscriptions ps on ps.id=pd.subscription_id and ps.user_id=pd.user_id and ps.active where pd.user_id=(select owner_id from crm_private.settings) and pd.state='queued' and pd.attempts<3 and pd.next_attempt_at<=now() and (pd.lease_until is null or pd.lease_until<now()) order by pd.next_attempt_at,pd.id for update of pd skip locked limit 1;
 if not found then return null; end if;
 update public.push_deliveries set attempts=attempts+1,lease_until=now()+interval '60 seconds',lease_token=gen_random_uuid() where id=d.id returning * into d;
 select * into s from public.push_subscriptions where user_id=d.user_id and id=d.subscription_id;
 return jsonb_build_object('id',d.id,'lease_token',d.lease_token,'task_id',d.crm_job_id,'endpoint',s.endpoint,'p256dh',s.p256dh,'auth',s.auth);
end $$;

create function crm_private.push_authorize(delivery uuid,token uuid) returns boolean language plpgsql security definer set search_path='' as $$
begin return exists(select 1 from public.push_deliveries d join public.push_subscriptions s on s.user_id=d.user_id and s.id=d.subscription_id where d.user_id=(select owner_id from crm_private.settings) and d.id=delivery and d.lease_token=token and d.lease_until>now() and d.state='queued' and s.active); end $$;
create function crm_private.push_finish(delivery uuid,token uuid,status integer) returns void language plpgsql security definer set search_path='' as $$
declare d public.push_deliveries;
begin
 select * into d from public.push_deliveries where id=delivery for update;
 if not found or not exists(select 1 from crm_private.settings where owner_id=d.user_id) or d.lease_token is distinct from token or d.lease_until<=now() or d.state<>'queued' then perform crm_private.fail('FORBIDDEN','Valid push delivery lease required'); end if;
 perform set_config('crm.actor_kind','worker',true); perform set_config('crm.operation','push.finish',true);
 if status in (404,410) then update public.push_subscriptions set active=false where user_id=d.user_id and id=d.subscription_id; end if;
 update public.push_deliveries set state=case when status between 200 and 299 then 'sent' when (status=0 or status=429 or status>=500) and attempts<3 then 'queued' else 'failed' end,lease_until=null,lease_token=null,next_attempt_at=now()+make_interval(secs=>30*power(2,attempts)::int) where id=d.id;
end $$;
revoke all on all functions in schema crm_private from public,anon,authenticated,crm_worker;
grant execute on function crm_private.is_owner() to authenticated;
grant execute on function crm_private.worker_claim(),crm_private.worker_finish(uuid,uuid,jsonb,jsonb),crm_private.worker_records(uuid,uuid),crm_private.worker_embeddings(uuid,uuid,jsonb,text),crm_private.worker_import(uuid,uuid),crm_private.push_claim(),crm_private.push_authorize(uuid,uuid),crm_private.push_finish(uuid,uuid,integer) to crm_worker;

-- Auth hook denies non-owner issuance and binds OAuth tokens to this MCP resource.
create function crm_private.access_token_hook(event jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare settings crm_private.settings; claims jsonb=event->'claims';
begin
 select * into settings from crm_private.settings;
 if settings.owner_id is distinct from (event->>'user_id')::uuid then return jsonb_build_object('error',jsonb_build_object('http_code',403,'message','Only the configured owner may sign in')); end if;
 if claims->>'client_id' is not null then claims=jsonb_set(claims,'{aud}',to_jsonb(settings.mcp_resource)); end if;
 return jsonb_build_object('claims',claims);
end $$;
grant usage on schema crm_private to supabase_auth_admin;
revoke all on function crm_private.access_token_hook(jsonb) from public,anon,authenticated,crm_worker;
grant execute on function crm_private.access_token_hook(jsonb) to supabase_auth_admin;

create or replace function crm_private.is_owner() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from crm_private.settings cfg join auth.sessions s on s.user_id=cfg.owner_id
 where cfg.owner_id=(select auth.uid()) and s.id=(auth.jwt()->>'session_id')::uuid
 and (s.not_after is null or s.not_after>now())
 and ((auth.jwt()->>'client_id') is null or exists(select 1 from auth.oauth_consents c where c.user_id=cfg.owner_id and c.client_id=(auth.jwt()->>'client_id')::uuid and c.revoked_at is null)))
$$;
create table crm_private.rate_limits(user_id uuid primary key references auth.users(id), window_start timestamptz not null, calls integer not null);
alter table crm_private.rate_limits enable row level security;
create function public.crm_authorize(p_mcp boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg crm_private.settings; n integer;
begin
 if auth.uid() is null then perform crm_private.fail('UNAUTHENTICATED','Sign in to continue'); end if;
 select * into cfg from crm_private.settings where owner_id=auth.uid();
 if not found then perform crm_private.fail('FORBIDDEN','This account is not the owner'); end if;
 if not crm_private.is_owner() then perform crm_private.fail('UNAUTHENTICATED','Session or OAuth grant was revoked'); end if;
 if p_mcp and (auth.jwt()->>'client_id' is null or auth.jwt()->>'aud' is distinct from cfg.mcp_resource) then perform crm_private.fail('UNAUTHENTICATED','Token must be issued for the MCP resource'); end if;
 insert into crm_private.rate_limits(user_id,window_start,calls) values(auth.uid(),now(),1) on conflict(user_id) do update set window_start=case when crm_private.rate_limits.window_start<now()-interval '1 minute' then now() else crm_private.rate_limits.window_start end,calls=case when crm_private.rate_limits.window_start<now()-interval '1 minute' then 1 else crm_private.rate_limits.calls+1 end returning calls into n;
 if n>200 then return jsonb_build_object('error',jsonb_build_object('code','RATE_LIMITED','message','Wait a minute before retrying','retryable',true)); end if;
 return jsonb_build_object('authorized',true);
exception when sqlstate 'CR001' then return jsonb_build_object('error',SQLERRM::jsonb);
end $$;
revoke all on function public.crm_authorize(boolean) from public,anon,authenticated;
grant execute on function public.crm_authorize(boolean) to authenticated;
