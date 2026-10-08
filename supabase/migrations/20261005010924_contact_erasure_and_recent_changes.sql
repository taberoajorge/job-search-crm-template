-- Canonical erasure only: protected originals, arbitrary text and backups are disclosed.
create table crm_private.contact_erasures(user_id uuid not null references auth.users(id),contact_id uuid not null,erased_at timestamptz not null default now(),primary key(user_id,contact_id));
alter table crm_private.contact_erasures enable row level security;
revoke all on crm_private.contact_erasures from public,anon,authenticated,crm_worker;

-- Match structured identities, never guessed names in arbitrary text.
create function crm_private.erasure_mentions(value jsonb,ids text[]) returns boolean language plpgsql immutable set search_path='' as $$
declare child jsonb;begin
 if jsonb_typeof(value)='string' then return value#>>'{}'=any(ids);end if;
 if jsonb_typeof(value)='object' then
  for child in select v from jsonb_each(value) e(k,v) loop if crm_private.erasure_mentions(child,ids) then return true;end if;end loop;
 elsif jsonb_typeof(value)='array' then
  for child in select v from jsonb_array_elements(value) e(v) loop if crm_private.erasure_mentions(child,ids) then return true;end if;end loop;
 end if;
 return false;
end $$;
create function crm_private.erasure_response(value jsonb,ids text[]) returns jsonb language plpgsql immutable set search_path='' as $$
#variable_conflict use_column
declare k text;v jsonb;result jsonb;begin
 if value is null then return null;end if;
 if jsonb_typeof(value)='object' then
  if value->>'erased'='true' then return value;end if;
  if value->>'id'=any(ids) or value->>'contact_id'=any(ids) then
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

create function crm_private.erasure_inventory(owner uuid,target uuid) returns jsonb language plpgsql set search_path='' as $$
declare c jsonb;o jsonb;i jsonb;a jsonb;r jsonb;t jsonb;l jsonb;e jsonb;ids text[];begin
 select to_jsonb(x) into c from public.contacts x where user_id=owner and id=target;
 if c is null then perform crm_private.fail('NOT_FOUND','Contact not found','id');end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') into o from public.outreach_events x where user_id=owner and contact_id=target;
 select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') into i from public.interviews x where user_id=owner and target=any(interviewer_ids);
 select array_agg(v) into ids from (select target::text v union select x->>'id' from jsonb_array_elements(o||i) x) s;
 select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') into a from public.audit_events x where user_id=owner and (entity_id::text=any(ids) or crm_private.erasure_mentions(before,ids) or crm_private.erasure_mentions(after,ids));
 select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') into r from public.mutation_receipts x where user_id=owner and crm_private.erasure_mentions(response,ids);
 select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') into l from public.legacy_links x where user_id=owner and entity_id::text=any(ids);
 select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') into t from public.crm_jobs x where user_id=owner and (crm_private.erasure_mentions(payload,ids) or crm_private.erasure_mentions(result,ids) or exists(
  select 1 from jsonb_array_elements(case when jsonb_typeof(payload->'records')='array' then payload->'records' else '[]' end) p join public.legacy_links ll on ll.user_id=owner and ll.import_namespace=payload->>'import_namespace' and ll.entity_type=p->>'entity_type' and ll.legacy_id=p->>'legacy_id' where ll.entity_id::text=any(ids)));
 select coalesce(jsonb_agg(to_jsonb(x) order by entity_type,entity_id),'[]') into e from crm_private.embeddings x where user_id=owner and entity_type='contacts' and entity_id=target;
 return jsonb_build_object('contact',c,'outreach',o,'interviews',i,'audits',a,'receipts',r,'import_tasks',t,'legacy_links',l,'embeddings',e);
end $$;

-- Append-only exceptions permit only exact metadata projection in this private transaction.
create or replace function crm_private.guard_audit_retention() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='UPDATE' and current_setting('crm.contact_erasure',true)=new.user_id::text and auth.uid()=new.user_id and crm_private.is_owner()
 and current_user=pg_get_userbyid((select proowner from pg_proc where oid='public.crm_operation(text,jsonb)'::regprocedure))
 and (to_jsonb(new)-array['before','after'])=(to_jsonb(old)-array['before','after'])
 and new.before is not distinct from crm_private.audit_payload_metadata(old.before)
 and new.after is not distinct from crm_private.audit_payload_metadata(old.after) then return new;end if;
 -- Existing ninety-day policy remains exact; trigger functions cannot be called directly.
 if tg_op='INSERT' then return new;end if;
 if current_setting('crm.audit_retention',true)='90days'
 and current_user=pg_get_userbyid((select proowner from pg_proc where oid='crm_private.minimize_audit_payloads()'::regprocedure))
 and old.user_id=(select owner_id from crm_private.settings) and old.created_at<=now()-interval '90 days'
 and (to_jsonb(new)-array['before','after'])=(to_jsonb(old)-array['before','after'])
 and new.before is not distinct from crm_private.audit_payload_metadata(old.before)
 and new.after is not distinct from crm_private.audit_payload_metadata(old.after) then return new;end if;
 raise exception using errcode='22023',message='Append-only audit';
end $$;

create function crm_private.guard_erasure_receipt() returns trigger language plpgsql set search_path='' as $$
declare ids text[]=string_to_array(current_setting('crm.erasure_ids',true),',');begin
 if current_setting('crm.contact_erasure',true)=new.user_id::text and auth.uid()=new.user_id and crm_private.is_owner()
 and current_user=pg_get_userbyid((select proowner from pg_proc where oid='public.crm_operation(text,jsonb)'::regprocedure))
 and (to_jsonb(new)-'response')=(to_jsonb(old)-'response')
 and new.response=crm_private.erasure_response(old.response,ids) then return new;end if;
 if tg_op='UPDATE' then raise exception using errcode='22023',message='Append-only receipt';end if;return new;
end $$;
drop trigger guard_record on public.mutation_receipts;
create trigger guard_record before insert or update on public.mutation_receipts for each row execute function crm_private.guard_erasure_receipt();

-- Erased identities remain relationships, but cannot acquire fresh personal bodies.
create function crm_private.guard_erased_identity() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_table_name='contacts' then
  if exists(select 1 from crm_private.contact_erasures where user_id=new.user_id and contact_id=new.id) then perform crm_private.fail('CONFLICT','Erased identity cannot be restored');end if;
 elsif tg_table_name='outreach_events' then
  if exists(select 1 from crm_private.contact_erasures where user_id=new.user_id and contact_id=new.contact_id) and (new.body<>'' or new.error is not null or new.external_ref is not null) then perform crm_private.fail('CONFLICT','Erased identity cannot be restored');end if;
 elsif tg_table_name='interviews' then
  if new.interviewer_notes<>'' and exists(select 1 from crm_private.contact_erasures where user_id=new.user_id and contact_id=any(new.interviewer_ids)) then perform crm_private.fail('CONFLICT','Erased identity cannot be restored');end if;
 end if;return new;
end $$;
create trigger guard_erased_identity before insert or update on public.contacts for each row execute function crm_private.guard_erased_identity();
create trigger guard_erased_identity before insert or update on public.outreach_events for each row execute function crm_private.guard_erased_identity();
create trigger guard_erased_identity before insert or update on public.interviews for each row execute function crm_private.guard_erased_identity();

create function crm_private.contact_erasure(owner uuid,op text,input jsonb) returns jsonb language plpgsql set search_path='' as $$
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
 select array_agg(v) into ids from (select target::text v union select x->>'id' from jsonb_array_elements(copies->'outreach'||(copies->'interviews')) x) s;
 perform set_config('crm.operation',op,true);perform set_config('crm.request_id',key::text,true);perform set_config('crm.actor_kind','user',true);perform set_config('crm.reason','',true);
 perform set_config('crm.contact_erasure',owner::text,true);perform set_config('crm.erasure_ids',array_to_string(ids,','),true);
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
end $$;

-- Reject fresh import intents targeting an erased structured identity before retaining payloads.
create function crm_private.reject_erased_import(owner uuid,payload jsonb) returns void language plpgsql set search_path='' as $$
declare item jsonb;target uuid;begin
 for item in select value from jsonb_array_elements(payload->'records') loop
  target=null;
  select entity_id into target from public.legacy_links where user_id=owner and import_namespace=payload->>'import_namespace' and entity_type=item->>'entity_type' and legacy_id=item->>'legacy_id';
  if exists(select 1 from crm_private.contact_erasures e where e.user_id=owner and (e.contact_id=target or crm_private.erasure_mentions(item,array[e.contact_id::text]))) then
   perform crm_private.fail('CONFLICT','Import contains an erased identity; review the source');
  end if;
 end loop;
end $$;
do $$declare definition text;marker text=$marker$ elsif op='tasks.submit' then$marker$;begin
 definition=pg_get_functiondef('crm_private.operation(uuid,text,jsonb,text)'::regprocedure);
 if strpos(definition,marker)=0 then raise exception 'Review import submission boundary before upgrading';end if;
 execute replace(definition,marker,marker||E'\n  if input->>''kind''=''bulk_import'' then perform crm_private.reject_erased_import(owner,input->''payload'');end if;');
end $$;
revoke all on function crm_private.reject_erased_import(uuid,jsonb) from public,anon,authenticated,crm_worker;

create index audit_events_recent_owner_entity on public.audit_events(user_id,entity_type,entity_id,created_at desc,id desc);
create function crm_private.dashboard_recent(owner uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object('event_id',a.id,'entity_type','jobs','entity_id',j.id,'action',left(a.action,100),'occurred_at',a.created_at,
 'changed_fields',case when a.action like 'import.%' or a.before is null then '[]'::jsonb else (select coalesce(jsonb_agg(k order by k),'[]') from unnest(array['title','stage','location','salary_text','salary_min','salary_max','currency','posting_url','description_summary','notes','resume_id','viewed','viewed_at','applied_at']) k where a.before ? k and a.after ? k and a.before->k is distinct from a.after->k) end,
 'history',case when a.action like 'import.%' or a.before is null or not a.before ? 'title' then 'unavailable' else 'recorded' end) order by j.updated_at desc,j.id) filter(where a.id is not null),'[]'), 'limit',12,'history_scope','canonical_audit')
 from (select id,updated_at from public.jobs where user_id=owner and stage not in ('archived','rejected') order by updated_at desc,id limit 12) j
 left join lateral (select * from public.audit_events where user_id=owner and entity_type='jobs' and entity_id=j.id order by created_at desc,case when after->>'version' ~ '^[0-9]{1,18}$' then (after->>'version')::bigint end desc nulls last,id desc limit 1) a on true;
$$;
create function crm_private.dashboard_workspace(owner uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object(
 'followup_count',(select count(*) from public.contacts c where c.user_id=owner and c.archived_at is null and (
  c.status='connected' or (c.status='uncontacted' and exists(select 1 from public.jobs j where j.user_id=owner and j.id=c.job_id and j.stage in ('applied','invited','messaged','replied','interview')))
  or (c.status='invited' and c.invite_at<now()-interval '7 days') or (c.status='messaged' and c.last_interacted_at<now()-interval '5 days'))),
 'featured_jobs',(select coalesce(jsonb_agg(to_jsonb(j) order by j.updated_at desc,j.id),'[]') from (select * from public.jobs where user_id=owner and stage not in ('rejected','archived') order by updated_at desc,id limit 3) j),
 'upcoming_interviews',(select coalesce(jsonb_agg(to_jsonb(i) order by i.scheduled_at,i.id),'[]') from (select * from public.interviews where user_id=owner and state='planned' and scheduled_at>=now() order by scheduled_at,id limit 3) i));
$$;
revoke all on function crm_private.dashboard_workspace(uuid) from public,anon,authenticated,crm_worker;
-- Keep the effective dispatcher/session boundary and every existing operation intact.
do $$declare definition text;marker text='result=crm_private.operation(auth.uid(),p_operation,p_input);';begin
 definition=pg_get_functiondef('public.crm_operation(text,jsonb)'::regprocedure);
 if strpos(definition,marker)=0 then raise exception 'Review effective owner dispatcher before upgrading';end if;
 definition=replace(definition,marker,E'if p_operation in (''contacts.preview_erasure'',''contacts.erase'') then return crm_private.contact_erasure(auth.uid(),p_operation,p_input);end if;\n '||marker||E'\n if p_operation=''dashboard.summary'' and not result ? ''error'' then result=result||jsonb_build_object(''recent_updates'',crm_private.dashboard_recent(auth.uid()),''workspace'',crm_private.dashboard_workspace(auth.uid()));end if;');
 execute definition;
end $$;
revoke all on function crm_private.erasure_mentions(jsonb,text[]),crm_private.erasure_response(jsonb,text[]),crm_private.erasure_inventory(uuid,uuid),crm_private.guard_audit_retention(),crm_private.guard_erasure_receipt(),crm_private.guard_erased_identity(),crm_private.contact_erasure(uuid,text,jsonb),crm_private.dashboard_recent(uuid) from public,anon,authenticated,crm_worker;

-- J125: SQL NULL comparisons must not accept missing notification booleans.
do $$declare definition text;marker text=$marker$jsonb_typeof(input->'read')<>'boolean'$marker$;begin
 definition=pg_get_functiondef('crm_private.notification_operation(uuid,text,jsonb)'::regprocedure);
 if strpos(definition,marker)=0 then raise exception 'Review notification validation before upgrading';end if;
 definition=replace(definition,marker,$new$jsonb_typeof(input->'read') is distinct from 'boolean'$new$);
 definition=replace(definition,$old$ perform crm_private.required(input,array['idempotency_key','expected_version']);$old$,$new$ perform crm_private.validate(input-array['read','live_email','disclosure','cutoff'],array['id','idempotency_key','expected_version']);
 perform crm_private.required(input,array['idempotency_key','expected_version']);$new$);
 definition=replace(definition,$old$  select * into b from public.notification_batches where user_id=owner and id=(input->>'id')::uuid for update;$old$,$new$  perform crm_private.required(input,array['id','read']);
  select * into b from public.notification_batches where user_id=owner and id=(input->>'id')::uuid for update;$new$);
 definition=replace(definition,$old$jsonb_typeof(input->'live_email')<>'boolean'$old$,$new$jsonb_typeof(input->'live_email') is distinct from 'boolean'$new$);
 definition=replace(definition,$old$   update public.notification_state set live_email=$old$,$new$   perform crm_private.required(input,array['live_email','disclosure']);
   update public.notification_state set live_email=$new$);
 execute definition;
end $$;
