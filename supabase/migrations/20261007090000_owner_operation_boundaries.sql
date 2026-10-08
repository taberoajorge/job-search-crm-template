-- Fences shared by every automation entry point. Replays of a stored receipt pass untouched.
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
 end if;
exception when invalid_text_representation or numeric_value_out_of_range then perform crm_private.fail('VALIDATION_ERROR','Invalid automation input');
end $$;
revoke all on function crm_private.automation_guard(uuid,text,jsonb) from public,anon,authenticated,crm_worker;

-- Claim-time interview enqueue is a mutation: a replayed claim returns its receipt without new effects.
do $$declare definition text;needle text=E'  for i in select * from public.automation_interview_intents where user_id=owner and active loop perform crm_private.enqueue_interview(owner,i.job_id,i.origin);end loop;';begin
 definition=pg_get_functiondef('crm_private.automation_operation(uuid,text,jsonb)'::regprocedure);
 if strpos(definition,E'then\n'||needle)>0 then return;end if;
 if strpos(definition,needle)=0 then raise exception 'Review claim-time interview enqueue before upgrading';end if;
 definition=replace(definition,needle,E'  if not exists(select 1 from public.mutation_receipts where user_id=owner and idempotency_key=(input->>\'idempotency_key\')::uuid) then\n'||needle||E'\n  end if;');
 execute definition;
end $$;

-- MCP OAuth grants reach only the reviewed catalog (packages/contracts/src/mcp/catalog.ts); UI-only flows stay with browser sessions.
create or replace function public.crm_operation(p_operation text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null then return jsonb_build_object('error',jsonb_build_object('code','UNAUTHENTICATED','message','Sign in to continue','retryable',false));end if;
 if not crm_private.is_owner() and exists(select 1 from crm_private.settings where owner_id=auth.uid()) then return jsonb_build_object('error',jsonb_build_object('code','UNAUTHENTICATED','message','Session revoked','retryable',false));end if;
 if auth.jwt()->>'client_id' is not null and coalesce(p_operation,'')<>all(array['automation.checkpoint','automation.claim','automation.commit','automation.company-guide.get','automation.company-guide.save','automation.configure','automation.heartbeat','automation.pack.get','automation.pack.save','automation.reserve','automation.status','automation.trigger','companies.health','companies.list','companies.upsert','contacts.search','contacts.upsert','dashboard.summary','interviews.list','interviews.upsert','jobs.get','jobs.list','jobs.transition','jobs.upsert','notifications.configure','notifications.get','notifications.list','notifications.mark_all','notifications.preferences','notifications.read','outreach.draft','outreach.list','outreach.mark_sent','outreach.queue','outreach.record_response','resumes.finalize','resumes.get_download','resumes.list','search.semantic','sources.list','sources.upsert','tasks.cancel','tasks.get','tasks.submit','verifications.record']) then
  return jsonb_build_object('error',jsonb_build_object('code','FORBIDDEN','message','Operation requires the owner workspace','retryable',false));
 end if;
 if p_operation like 'notifications.%' then return crm_private.notification_operation(auth.uid(),p_operation,p_input);end if;
 if p_operation like 'automation.%' then
  perform crm_private.automation_guard(auth.uid(),p_operation,p_input);
  return crm_private.automation_operation(auth.uid(),p_operation,p_input);
 end if;
 if p_operation='jobs.list' then return crm_private.jobs_page(auth.uid(),p_input);end if;
 if p_operation in ('contacts.preview_erasure','contacts.erase') then return crm_private.contact_erasure(auth.uid(),p_operation,p_input);end if;
 result=crm_private.operation(auth.uid(),p_operation,p_input);
 if p_operation='dashboard.summary' and not result ? 'error' then result=result||jsonb_build_object('recent_updates',crm_private.dashboard_recent(auth.uid()),'workspace',crm_private.dashboard_workspace(auth.uid()));end if;
 if p_operation='jobs.get' and result ? 'id' and not result ? 'error' then
  result=result||jsonb_build_object('triage',crm_private.job_triage(auth.uid(),(result->>'id')::uuid));
 end if;
 return result;
exception when sqlstate 'CR001' then return jsonb_build_object('error',SQLERRM::jsonb);
 when invalid_text_representation then return jsonb_build_object('error',jsonb_build_object('code','UNAUTHENTICATED','message','Invalid session','retryable',false));
end $$;
