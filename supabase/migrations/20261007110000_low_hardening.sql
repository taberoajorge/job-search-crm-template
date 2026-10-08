-- A provider poll that keeps failing is blocked for review after 30 attempts, keeping its provider identity (A-06);
-- manual retries honour retry_failed (contracts-025).
create or replace function crm_private.automation_guard(owner uuid,op text,input jsonb) returns void language plpgsql set search_path='' as $$
declare p public.automation_policies;c public.contacts;f text;begin
 if owner is distinct from auth.uid() or not crm_private.is_owner() or jsonb_typeof(input) is distinct from 'object' then return;end if;
 perform pg_advisory_xact_lock(hashtextextended(owner::text,0));
 if input->>'idempotency_key'~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and exists(select 1 from public.mutation_receipts where user_id=owner and idempotency_key=(input->>'idempotency_key')::uuid) then return;end if;
 -- Optimistic versions are mandatory; a missing value must not compare as NULL and pass.
 foreach f in array case when op in ('automation.configure','automation.checkpoint','automation.reserve','automation.commit') then array['expected_version']
  when op='automation.pack.save' then array['expected_version','job_version','resume_version','expected_pack_version'] else array[]::text[] end loop
  if jsonb_typeof(input->f) is distinct from 'number' or input->>f!~'^\d{1,18}$' then perform crm_private.fail('VALIDATION_ERROR','Expected version required',f);end if;
 end loop;
 -- Automation may create uncontacted people or link an unassigned one; owner-recorded facts stay owner-only.
 if op='automation.commit' and input->>'operation'='contacts.upsert' and jsonb_typeof(input->'input')='object' and input->'input' ? 'id' then
  if (input->'input')-array['id','expected_version','job_id','idempotency_key']<>'{}' then perform crm_private.fail('FORBIDDEN','Automation may only link existing contacts');end if;
  select * into c from public.contacts where user_id=owner and id=(input->'input'->>'id')::uuid;
  if found and input->'input' ? 'job_id' and (c.status<>'uncontacted' or c.job_id is not null and c.job_id is distinct from (input->'input'->>'job_id')::uuid
   or c.company_id is distinct from (select j.company_id from public.jobs j where j.user_id=owner and j.id=(input->'input'->>'job_id')::uuid)) then
   perform crm_private.fail('FORBIDDEN','Only an unassigned uncontacted contact of the job company can be linked');
  end if;
 end if;
 select * into p from public.automation_policies where user_id=owner;
 if not found then return;end if;
 -- Explicit owner retry also covers failures recorded under an earlier policy version.
 if op='automation.trigger' and input->'retry_failed'='true'::jsonb and (p.policy->>'enabled')::boolean then
  update public.automation_work w set policy_version=p.version,version=w.version+1,updated_at=now()
  where w.user_id=owner and w.policy_version<>p.version and w.kind in ('prepare','interview','discovery') and w.state in ('waiting','blocked','failed')
   and w.error in ('RETRY_LIMIT','MODEL_INTERRUPTED','MODEL_SCHEMA_INVALID') and exists(select 1 from public.automation_profiles r where r.user_id=owner and r.id=w.profile_id);
 end if;
 -- A manual run with retry_failed also requeues retry-limited work of its scope (contracts-025); paid research is not retried.
 if op='automation.trigger' and input->'retry_failed'='true'::jsonb and input->>'on_demand'='true' then
  update public.automation_work w set state='queued',attempts=0,error=null,policy_version=p.version,next_attempt_at=now(),version=w.version+1,updated_at=now()
  where w.user_id=owner and w.kind=any(case input->>'scope' when 'discovery' then array['discovery'] when 'existing' then array['prepare','interview'] when 'classification' then array['classify'] else array[]::text[] end)
   and w.state in ('waiting','blocked','failed') and w.error in ('RETRY_LIMIT','MODEL_INTERRUPTED','MODEL_SCHEMA_INVALID') and exists(select 1 from public.automation_profiles r where r.user_id=owner and r.id=w.profile_id);
 end if;
 -- Work left by a superseded policy must not hold its profile/job slot forever (crashed executor, save mid-run).
 if op='automation.claim' then
  update public.automation_work set state='blocked',error='EXA_CREATE_AMBIGUOUS',lease_token=null,lease_until=null,version=version+1,updated_at=now()
  where user_id=owner and policy_version<>p.version and state='running' and lease_until<now() and checkpoint->>'provider_id' is null and checkpoint->>'dispatching'='true';
  update public.automation_work set state='queued',policy_version=p.version,lease_token=null,lease_until=null,next_attempt_at=now(),version=version+1,updated_at=now()
  where user_id=owner and policy_version<>p.version and state='running' and lease_until<now() and kind='interview' and checkpoint->>'content_version'='2' and checkpoint->>'provider_id' is null;
  update public.automation_work set state='cancelled',error=coalesce(error,'POLICY_SUPERSEDED'),lease_token=null,lease_until=null,version=version+1,updated_at=now()
  where user_id=owner and policy_version<>p.version and (state in ('queued','waiting','blocked') or state='running' and lease_until<now())
   and not (kind in ('research','interview') and checkpoint->>'provider_id' is not null)
   and not (kind='interview' and checkpoint->>'content_version' is not distinct from '2' and state<>'running')
   and error is distinct from 'EXA_CREATE_AMBIGUOUS' and not (checkpoint->>'provider_id' is null and checkpoint->>'dispatching' is not distinct from 'true');
  -- Recovering an accepted provider run is unbounded by design, but a poll that keeps failing needs the owner.
  update public.automation_work set state='blocked',error='PROVIDER_POLL_REVIEW',lease_token=null,lease_until=null,version=version+1,updated_at=now()
  where user_id=owner and kind in ('research','interview') and checkpoint->>'provider_id' is not null and attempts>=30 and (state='waiting' or state='running' and lease_until<now());
 end if;
exception when invalid_text_representation or numeric_value_out_of_range then perform crm_private.fail('VALIDATION_ERROR','Invalid automation input');
end $$;

-- Contact responses never rewind a later status or interaction date (F-04); oversized numbers are validation errors (F-05).
do $$declare definition text;
 response_needle text=$n$c=crm_private.save('contacts',owner,jsonb_build_object('status','replied','last_interacted_at',input->'occurred_at'),(c->>'id')::uuid,(c->>'version')::bigint);$n$;
 handler_needle text=$n$when check_violation or not_null_violation or invalid_text_representation or datetime_field_overflow or invalid_parameter_value then$n$;
begin
 definition=pg_get_functiondef('crm_private.operation(uuid,text,jsonb,text)'::regprocedure);
 if strpos(definition,'or numeric_value_out_of_range then')>0 then return;end if;
 if strpos(definition,response_needle)=0 or strpos(definition,handler_needle)=0 then raise exception 'Review contact response handling before upgrading';end if;
 definition=replace(definition,response_needle,$r$c=crm_private.save('contacts',owner,case when c->>'status'='interview' then '{}'::jsonb else jsonb_build_object('status','replied') end||jsonb_build_object('last_interacted_at',to_jsonb(greatest((c->>'last_interacted_at')::timestamptz,(input->>'occurred_at')::timestamptz))),(c->>'id')::uuid,(c->>'version')::bigint);$r$);
 definition=replace(definition,handler_needle,$r$when check_violation or not_null_violation or invalid_text_representation or datetime_field_overflow or invalid_parameter_value or numeric_value_out_of_range then$r$);
 execute definition;
end $$;

-- Malformed cursors/cutoffs and duplicate identities return the structured envelope (A-05, openspec-068).
do $$declare definition text;
 cutoff_needle text=$n$or not input ? 'cutoff' then perform crm_private.fail('VALIDATION_ERROR','Cutoff required');$n$;
 handler_needle text=$n$ when invalid_text_representation or invalid_parameter_value or check_violation or not_null_violation then return jsonb_build_object('error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid notification input','retryable',false));$n$;
begin
 definition=pg_get_functiondef('crm_private.notification_operation(uuid,text,jsonb)'::regprocedure);
 if strpos(definition,'untranslatable_character')=0 then
 if strpos(definition,cutoff_needle)=0 or strpos(definition,handler_needle)=0 then raise exception 'Review notification validation before upgrading';end if;
 definition=replace(definition,cutoff_needle,$r$or jsonb_typeof(input->'cutoff') is distinct from 'string' then perform crm_private.fail('VALIDATION_ERROR','Cutoff required');$r$);
 definition=replace(definition,handler_needle,$r$ when invalid_text_representation or invalid_parameter_value or check_violation or not_null_violation or invalid_datetime_format or datetime_field_overflow or character_not_in_repertoire or untranslatable_character then return jsonb_build_object('error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid notification input','retryable',false));$r$);
 execute definition;
 end if;
 foreach definition in array array['crm_private.automation_operation_before_notifications(uuid,text,jsonb)','crm_private.automation_operation(uuid,text,jsonb)'] loop
  definition=pg_get_functiondef(definition::regprocedure);
  continue when strpos(definition,'Work or request identity already exists')>0;
  if strpos(definition,E'exception when sqlstate \'CR001\' then return jsonb_build_object(\'error\',SQLERRM::jsonb);')=0 then raise exception 'Review automation error envelope before upgrading';end if;
  execute replace(definition,E'exception when sqlstate \'CR001\' then return jsonb_build_object(\'error\',SQLERRM::jsonb);',E'exception when sqlstate \'CR001\' then return jsonb_build_object(\'error\',SQLERRM::jsonb);\n when unique_violation then return jsonb_build_object(\'error\',jsonb_build_object(\'code\',\'CONFLICT\',\'message\',\'Work or request identity already exists\',\'retryable\',false));');
 end loop;
end $$;

-- Foreign keys used by deletes/joins get covering indexes (E-08); text search no longer uses these indexes (E-09).
create index if not exists automation_events_job on public.automation_events(user_id,job_id);
create index if not exists automation_reservations_work on public.automation_reservations(user_id,work_id);
create index if not exists settings_owner on crm_private.settings(owner_id);
drop index if exists public.jobs_search;
drop index if exists public.companies_name_trgm;
drop index if exists public.contacts_name_trgm;

-- Only the v2 sender remains (E-12).
revoke execute on function crm_private.automation_email_claim(),crm_private.automation_email_claim_legacy() from crm_worker;

-- The auth hook needs only the owner row; run it with the auth admin's own narrow grant (R-03).
grant select on crm_private.settings to supabase_auth_admin;
alter function crm_private.access_token_hook(jsonb) security invoker;

-- New public objects are private until explicitly granted (R-05).
alter default privileges in schema public revoke all on tables from anon,authenticated;
alter default privileges in schema public revoke all on sequences from anon,authenticated;
alter default privileges in schema public revoke all on functions from public,anon,authenticated;
alter default privileges in schema crm_private revoke all on functions from public;

-- Only canonical IANA zones that clients can read back (contracts-008).
do $$declare definition text;f text;begin
 foreach f in array array['crm_private.validate_entity(text,jsonb,boolean)','crm_private.guard_record()','crm_private.validate_automation_policy_before_flows(jsonb,uuid)'] loop
  definition=pg_get_functiondef(f::regprocedure);
  continue when strpos(definition,'(posix|right)/')>0;
  if definition !~ 'pg_timezone_names where name=' then raise exception 'Review timezone validation in % before upgrading',f;end if;
  execute regexp_replace(definition,'(pg_timezone_names where name=([^)]+?))\)',$r$\1 and \2 !~ '^(posix|right)/' and \2<>'Factory')$r$,'g');
 end loop;
end $$;

-- Evidence timestamps carry seconds and an explicit offset (contracts-028); CHECK failures name their field (contracts-010);
-- push.deactivate needs an explicit device (contracts-021); a backfilled send never rewinds the last interaction
-- (live-e2e mark_sent report); invitation notes fit LinkedIn's 300 characters (supabase-edge-025).
do $$declare definition text;
 evidence_needle text=$n$e->>'checked_at' !~ '^\d{4}-\d{2}-\d{2}T'$n$;
 field_needle text=$n$'field',nullif(error_field,'')$n$;
 push_needle text=$n$ elsif op='push.deactivate' then
$n$;
 sent_needle text=$n$jsonb_build_object('last_interacted_at',input->'occurred_at')||case when r->>'kind'='invitation'$n$;
 draft_needle text=$n$  perform crm_private.required(input,array['body','channel','kind']);
$n$;
begin
 definition=pg_get_functiondef('crm_private.validate_explanation(jsonb)'::regprocedure);
 if strpos(definition,evidence_needle)>0 then
 execute replace(definition,evidence_needle,$r$e->>'checked_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'$r$);
 end if;
 definition=pg_get_functiondef('crm_private.operation(uuid,text,jsonb,text)'::regprocedure);
 if strpos(definition,'Invitation note max 300 characters')>0 then return;end if;
 if strpos(definition,field_needle)=0 or strpos(definition,push_needle)=0 or strpos(definition,sent_needle)=0 or strpos(definition,draft_needle)=0 then raise exception 'Review operation validation before upgrading';end if;
 definition=replace(definition,sent_needle,$r$jsonb_build_object('last_interacted_at',to_jsonb(greatest((c->>'last_interacted_at')::timestamptz,(input->>'occurred_at')::timestamptz)))||case when r->>'kind'='invitation'$r$);
 definition=replace(definition,draft_needle,draft_needle||$r$  if input->>'kind'='invitation' and length(input->>'body')>300 then perform crm_private.fail('VALIDATION_ERROR','Invitation note max 300 characters','body');end if;
$r$);
 definition=replace(definition,field_needle,$r$'field',coalesce(nullif(error_field,''),case when SQLERRM like '%"jobs_money_currency"%' then 'currency' end)$r$);
 definition=replace(definition,push_needle,push_needle||$r$  if input->>'endpoint' is null and input->>'id' is null then perform crm_private.fail('VALIDATION_ERROR','Choose the device to deactivate','endpoint');end if;
$r$);
 execute definition;
end $$;

-- Erased copies keep ids, states and timestamps; notes and other personal free text go (L-09, owner decision).
create or replace function crm_private.erasure_response(value jsonb,ids text[]) returns jsonb language plpgsql immutable set search_path='' as $$
#variable_conflict use_column
declare k text;v jsonb;result jsonb;begin
 if value is null then return null;end if;
 if jsonb_typeof(value)='object' then
  if value->>'erased'='true' then return value;end if;
  if value->>'id'=any(ids) or value->>'contact_id'=any(ids) or value->>'linkedin_url'=any(ids) or value->>'email'=any(ids) then
   return crm_private.audit_payload_metadata(value)||coalesce((select jsonb_object_agg(t.k,t.v) from jsonb_each(value) t(k,v)
    where t.k in ('created_at','updated_at','scheduled_at','occurred_at','checked_at') and jsonb_typeof(t.v)='string'),'{}'::jsonb)||jsonb_build_object('erased',true);
  end if;
  result='{}';
  for k,v in select * from jsonb_each(value) loop result=result||jsonb_build_object(k,crm_private.erasure_response(v,ids));end loop;
  return result;
 elsif jsonb_typeof(value)='array' then
  select coalesce(jsonb_agg(crm_private.erasure_response(v,ids) order by n),'[]') into result from jsonb_array_elements(value) with ordinality e(v,n);return result;
 end if;
 return value;
end $$;
