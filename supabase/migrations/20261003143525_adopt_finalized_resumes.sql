-- Adopt an already finalized owner CV without changing its immutable bytes, identity or version.
create or replace function crm_private.worker_import(task uuid,token uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.crm_jobs; item jsonb; data jsonb; entity text; linked uuid; child uuid; result jsonb; results jsonb='[]'; existing public.mutation_receipts; hash text; a uuid; adopted jsonb;
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
   if entity='resumes' then
    perform crm_private.required(data,array['id','label','storage_path','checksum','media_type']);
    select to_jsonb(r) into adopted from public.resumes r where r.id=(data->>'id')::uuid for update;
    if found then
     if adopted->>'user_id'<>j.user_id::text then perform crm_private.fail('FORBIDDEN','Resume belongs to a different owner'); end if;
     if not (adopted @> data) then perform crm_private.fail('CONFLICT','Finalized resume metadata differs from import'); end if;
     if not exists(select 1 from storage.objects where bucket_id='resumes' and name=adopted->>'storage_path') then perform crm_private.fail('NOT_FOUND','Finalized resume bytes are missing'); end if;
     result=adopted;
     insert into public.audit_events(user_id,entity_type,entity_id,action,actor_subject,actor_kind,request_id,before,after)
     values(j.user_id,'resumes',(result->>'id')::uuid,'import.resumes.adopt','crm_worker','worker',child,result-'storage_path',result-'storage_path');
    else
     result=crm_private.save(entity,j.user_id,data-'id',null,null,(data->>'id')::uuid);
    end if;
   else
    result=crm_private.save(entity,j.user_id,data-'id',null,null,(data->>'id')::uuid);
   end if;
   if entity='resumes' then result=result-'storage_path'; end if;
   insert into public.legacy_links(user_id,import_namespace,entity_type,legacy_id,entity_id) values(j.user_id,j.payload->>'import_namespace',entity,item->>'legacy_id',(result->>'id')::uuid);
   insert into public.mutation_receipts(user_id,idempotency_key,operation,payload_hash,response) values(j.user_id,child,'import.'||entity,hash,result);
  end if;
  results=results||jsonb_build_array(jsonb_build_object('entity_type',entity,'legacy_id',item->>'legacy_id','id',result->'id','version',result->'version','needs_review',entity='jobs' and result->>'applied_at' is null and result->>'stage' in ('applied','invited','messaged','replied','interview','offer','rejected')));
 end loop;
 perform crm_private.worker_finish(task,token,jsonb_build_object('records',results,'import_namespace',j.payload->'import_namespace'));
 return jsonb_build_object('records',results);
end $$;

revoke all on function crm_private.worker_import(uuid,uuid) from public,anon,authenticated;
grant execute on function crm_private.worker_import(uuid,uuid) to crm_worker;
