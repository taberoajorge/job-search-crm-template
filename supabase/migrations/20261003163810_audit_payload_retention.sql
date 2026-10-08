-- Owner-approved policy: full audit bodies for 90 days; minimized metadata retained indefinitely.
-- Receipts, tasks, ordinary business rows and backups are outside this policy.
create function crm_private.audit_payload_metadata(payload jsonb) returns jsonb language plpgsql immutable set search_path='' as $$
declare k text;v jsonb;result jsonb='{}';
begin
 if payload is null then return null;end if;
 if jsonb_typeof(payload)<>'object' then return result;end if;
 for k,v in select * from jsonb_each(payload) loop
  if k in ('id','company_id','job_id','contact_id','resume_id','source_id','entity_id') and jsonb_typeof(v)='string' and (v#>>'{}')~*'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then result=result||jsonb_build_object(k,v);
  elsif k='version' and jsonb_typeof(v)='number' and (v#>>'{}')~'^[1-9][0-9]{0,17}$' then result=result||jsonb_build_object(k,v);
  elsif k='stage' and jsonb_typeof(v)='string' and (v#>>'{}') in ('radar','review','ready','applied','invited','messaged','replied','interview','offer','rejected','archived') then result=result||jsonb_build_object(k,v);
  elsif k='status' and jsonb_typeof(v)='string' and (v#>>'{}') in ('uncontacted','invited','connected','messaged','replied','interview','no_response','pending','partial','confirmed','ambiguous','closed') then result=result||jsonb_build_object(k,v);
  elsif k='state' and jsonb_typeof(v)='string' and (v#>>'{}') in ('draft','queued','sent','failed','responded','cancelled','planned','running','completed','accepted') then result=result||jsonb_build_object(k,v);
  -- The current historical funnel reads applied_at; other record dates are unnecessary here.
  elsif k='applied_at' and (v='null'::jsonb or (jsonb_typeof(v)='string' and (v#>>'{}')~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$')) then result=result||jsonb_build_object(k,v);
  end if;
 end loop;
 return result;
end $$;

create function crm_private.guard_audit_retention() returns trigger language plpgsql set search_path='' as $$
begin
 if TG_OP<>'UPDATE' then return new;end if;
 if current_setting('crm.audit_retention',true)='90days'
  and current_user=pg_get_userbyid((select proowner from pg_catalog.pg_proc where oid='crm_private.minimize_audit_payloads()'::regprocedure))
  and old.user_id=(select owner_id from crm_private.settings)
  and old.created_at<=now()-interval '90 days'
  and (to_jsonb(new)-array['before','after'])=(to_jsonb(old)-array['before','after'])
  and new.before is not distinct from crm_private.audit_payload_metadata(old.before)
  and new.after is not distinct from crm_private.audit_payload_metadata(old.after)
 then return new;end if;
 raise exception using errcode='22023',message='Append-only audit; only authorized expired-payload minimization is permitted';
end $$;

create function crm_private.minimize_audit_payloads() returns integer language plpgsql security definer set search_path='' as $$
declare changed integer;owner uuid;previous_flag text=current_setting('crm.audit_retention',true);
begin
 select owner_id into owner from crm_private.settings;
 if owner is null then return 0;end if;
 -- Serialize maintenance only; this does not block ordinary business mutations.
 perform pg_advisory_xact_lock(hashtextextended('crm-audit-retention:'||owner::text,0));
 perform set_config('crm.audit_retention','90days',true);
 update public.audit_events a set before=crm_private.audit_payload_metadata(a.before),after=crm_private.audit_payload_metadata(a.after)
 where a.user_id=owner and a.created_at<=now()-interval '90 days'
 and (a.before is distinct from crm_private.audit_payload_metadata(a.before) or a.after is distinct from crm_private.audit_payload_metadata(a.after));
 get diagnostics changed=row_count;
 if changed>0 then
  -- Payload-free operator audit: no original snapshots, free-text reasons or recipient data.
  insert into public.audit_events(user_id,entity_type,entity_id,action,actor_subject,actor_kind,request_id,before,after)
  values(owner,'audit_retention',owner,'audit.payload_retention','crm_retention','worker',gen_random_uuid(),null,'{}');
 end if;
 perform set_config('crm.audit_retention',coalesce(previous_flag,''),true);
 return changed;
exception when others then
 perform set_config('crm.audit_retention',coalesce(previous_flag,''),true);
 raise;
end $$;

drop trigger guard_record on public.audit_events;
create trigger guard_record before insert or update on public.audit_events for each row execute function crm_private.guard_audit_retention();
revoke all on function crm_private.audit_payload_metadata(jsonb),crm_private.guard_audit_retention(),crm_private.minimize_audit_payloads() from public,anon,authenticated,crm_worker;
do $$begin
 if to_regrole('service_role') is not null then
  execute 'revoke all on function crm_private.audit_payload_metadata(jsonb),crm_private.guard_audit_retention(),crm_private.minimize_audit_payloads() from service_role';
 end if;
 -- Existing pg_cron is reused. Native PG without cron still replays the policy and tests it.
 if to_regprocedure('cron.schedule(text,text,text)') is not null then
  perform cron.schedule('crm-audit-retention','17 3 * * *','select crm_private.minimize_audit_payloads();');
 end if;
end $$;
