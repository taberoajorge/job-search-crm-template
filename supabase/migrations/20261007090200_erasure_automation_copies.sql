-- Automation copies (contact proposals, guarded request intents and their receipts) carry no contact UUID
-- before commit, so the erased contact's exact LinkedIn URL and email also mark structured copies.
create or replace function crm_private.erasure_response(value jsonb,ids text[]) returns jsonb language plpgsql immutable set search_path='' as $$
#variable_conflict use_column
declare k text;v jsonb;result jsonb;begin
 if value is null then return null;end if;
 if jsonb_typeof(value)='object' then
  if value->>'erased'='true' then return value;end if;
  if value->>'id'=any(ids) or value->>'contact_id'=any(ids) or value->>'linkedin_url'=any(ids) or value->>'email'=any(ids) then
   return crm_private.audit_payload_metadata(value)||jsonb_build_object('erased',true);
  end if;
  result='{}';
  for k,v in select * from jsonb_each(value) loop result=result||jsonb_build_object(k,crm_private.erasure_response(v,ids));end loop;
  return result;
 elsif jsonb_typeof(value)='array' then
  select coalesce(jsonb_agg(crm_private.erasure_response(v,ids) order by n),'[]') into result from jsonb_array_elements(value) with ordinality e(v,n);return result;
 end if;
 return value;
end $$;

create or replace function crm_private.erasure_inventory(owner uuid,target uuid) returns jsonb language plpgsql set search_path='' as $$
declare c jsonb;o jsonb;i jsonb;a jsonb;r jsonb;t jsonb;l jsonb;e jsonb;w jsonb;ids text[];begin
 select to_jsonb(x) into c from public.contacts x where user_id=owner and id=target;
 if c is null then perform crm_private.fail('NOT_FOUND','Contact not found','id');end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') into o from public.outreach_events x where user_id=owner and contact_id=target;
 select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') into i from public.interviews x where user_id=owner and target=any(interviewer_ids);
 select array_agg(v) into ids from (select target::text v union select x->>'id' from jsonb_array_elements(o||i) x
  union select nullif(c->>k,'') from unnest(array['linkedin_url','email']) k) s where v is not null;
 select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') into a from public.audit_events x where user_id=owner and (entity_id::text=any(ids) or crm_private.erasure_mentions(before,ids) or crm_private.erasure_mentions(after,ids));
 select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') into r from public.mutation_receipts x where user_id=owner and crm_private.erasure_mentions(response,ids);
 select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') into l from public.legacy_links x where user_id=owner and entity_id::text=any(ids);
 select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') into t from public.crm_jobs x where user_id=owner and (crm_private.erasure_mentions(payload,ids) or crm_private.erasure_mentions(result,ids) or exists(
  select 1 from jsonb_array_elements(case when jsonb_typeof(payload->'records')='array' then payload->'records' else '[]' end) p join public.legacy_links ll on ll.user_id=owner and ll.import_namespace=payload->>'import_namespace' and ll.entity_type=p->>'entity_type' and ll.legacy_id=p->>'legacy_id' where ll.entity_id::text=any(ids)));
 select coalesce(jsonb_agg(to_jsonb(x) order by entity_type,entity_id),'[]') into e from crm_private.embeddings x where user_id=owner and entity_type='contacts' and entity_id=target;
 select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'version',x.version) order by x.id),'[]') into w from public.automation_work x where user_id=owner and crm_private.erasure_mentions(checkpoint,ids);
 return jsonb_build_object('contact',c,'outreach',o,'interviews',i,'audits',a,'receipts',r,'import_tasks',t,'legacy_links',l,'embeddings',e,'automation_work',w);
end $$;

-- URLs may contain commas; identifiers travel unit-separated.
create or replace function crm_private.guard_erasure_receipt() returns trigger language plpgsql set search_path='' as $$
declare ids text[]=string_to_array(current_setting('crm.erasure_ids',true),E'\x1f');begin
 if current_setting('crm.contact_erasure',true)=new.user_id::text and auth.uid()=new.user_id and crm_private.is_owner()
 and current_user=pg_get_userbyid((select proowner from pg_proc where oid='public.crm_operation(text,jsonb)'::regprocedure))
 and (to_jsonb(new)-'response')=(to_jsonb(old)-'response')
 and new.response=crm_private.erasure_response(old.response,ids) then return new;end if;
 if tg_op='UPDATE' then raise exception using errcode='22023',message='Append-only receipt';end if;return new;
end $$;

do $$declare definition text;
 ids_needle text=$n$select array_agg(v) into ids from (select target::text v union select x->>'id' from jsonb_array_elements(copies->'outreach'||(copies->'interviews')) x) s;$n$;
 sep_needle text=$n$set_config('crm.erasure_ids',array_to_string(ids,','),true);$n$;
 audit_needle text=$n$ -- Includes the erasure transaction's newly generated snapshots, so no old body survives.$n$;
begin
 definition=pg_get_functiondef('crm_private.contact_erasure(uuid,text,jsonb)'::regprocedure);
 if strpos(definition,'update public.automation_work set checkpoint=crm_private.erasure_response')>0 then return;end if;
 if strpos(definition,ids_needle)=0 or strpos(definition,sep_needle)=0 or strpos(definition,audit_needle)=0 then raise exception 'Review contact erasure before upgrading';end if;
 definition=replace(definition,ids_needle,$r$select array_agg(v) into ids from (select target::text v union select x->>'id' from jsonb_array_elements(copies->'outreach'||(copies->'interviews')) x
  union select nullif(copies->'contact'->>k,'') from unnest(array['linkedin_url','email']) k) s where v is not null;$r$);
 definition=replace(definition,sep_needle,$r$set_config('crm.erasure_ids',array_to_string(ids,E'\x1f'),true);$r$);
 definition=replace(definition,audit_needle,$r$ update public.automation_work set checkpoint=crm_private.erasure_response(checkpoint,ids),version=version+1,updated_at=now() where user_id=owner and crm_private.erasure_mentions(checkpoint,ids);
$r$||audit_needle);
 execute definition;
end $$;
