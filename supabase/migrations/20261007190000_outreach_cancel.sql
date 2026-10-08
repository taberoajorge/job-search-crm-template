-- outreach.cancel: the owner withdraws a queued human reminder (not yet sent, due or overdue). Versioned, idempotent
-- and audited with the owner's reason; the row and its history stay, drafts and settled events are never rewritten.
create or replace function crm_private.outreach_cancel(owner uuid,input jsonb) returns jsonb language plpgsql set search_path='' as $$
declare key uuid;hash text;receipt public.mutation_receipts;r jsonb;result jsonb;begin
 if owner is null or owner is distinct from auth.uid() or not crm_private.is_owner() then perform crm_private.fail('FORBIDDEN','Owner session required');end if;
 perform crm_private.validate(input,array['id','expected_version','reason','idempotency_key']);
 perform crm_private.required(input,array['id','expected_version','reason','idempotency_key']);
 key=(input->>'idempotency_key')::uuid;hash=encode(extensions.digest('outreach.cancel'||input::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(owner::text,0));
 select * into receipt from public.mutation_receipts where user_id=owner and idempotency_key=key;
 if found then
  if receipt.operation<>'outreach.cancel' or receipt.payload_hash<>hash then perform crm_private.fail('IDEMPOTENCY_CONFLICT','Idempotency key was used for different input','idempotency_key');end if;
  return receipt.response;
 end if;
 perform set_config('crm.operation','outreach.cancel',true);perform set_config('crm.request_id',key::text,true);
 perform set_config('crm.actor_kind','user',true);perform set_config('crm.reason',trim(input->>'reason'),true);
 r=crm_private.record('outreach_events',owner,(input->>'id')::uuid,(input->>'expected_version')::bigint);
 if r->>'state' is distinct from 'queued' then perform crm_private.fail('CONFLICT','Only queued outreach can be cancelled','state',(r->>'version')::bigint);end if;
 result=crm_private.save('outreach_events',owner,jsonb_build_object('state','cancelled'),(r->>'id')::uuid,(r->>'version')::bigint);
 insert into public.mutation_receipts(user_id,idempotency_key,operation,payload_hash,response) values(owner,key,'outreach.cancel',hash,result);
 return result;
exception when sqlstate 'CR001' then return jsonb_build_object('error',SQLERRM::jsonb);
 when invalid_text_representation or numeric_value_out_of_range then return jsonb_build_object('error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid field value','retryable',false));
end $$;
revoke all on function crm_private.outreach_cancel(uuid,jsonb) from public,anon,authenticated,crm_worker;

-- Route the operation and publish it to MCP grants (the owner cancels queued sends from agents too).
create or replace function public.crm_operation(p_operation text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null then return jsonb_build_object('error',jsonb_build_object('code','UNAUTHENTICATED','message','Sign in to continue','retryable',false));end if;
 if not crm_private.is_owner() and exists(select 1 from crm_private.settings where owner_id=auth.uid()) then return jsonb_build_object('error',jsonb_build_object('code','UNAUTHENTICATED','message','Session revoked','retryable',false));end if;
 if auth.jwt()->>'client_id' is not null and coalesce(p_operation,'')<>all(array['automation.checkpoint','automation.claim','automation.commit','automation.company-guide.get','automation.company-guide.save','automation.configure','automation.heartbeat','automation.pack.get','automation.pack.save','automation.reserve','automation.status','automation.trigger','companies.health','companies.list','companies.upsert','contacts.search','contacts.upsert','dashboard.summary','interviews.list','interviews.upsert','jobs.get','jobs.list','jobs.transition','jobs.upsert','notifications.configure','notifications.get','notifications.list','notifications.mark_all','notifications.preferences','notifications.read','outreach.cancel','outreach.draft','outreach.list','outreach.mark_sent','outreach.queue','outreach.record_response','resumes.finalize','resumes.get_download','resumes.list','search.semantic','sources.list','sources.upsert','tasks.cancel','tasks.get','tasks.submit','verifications.record']) then
  return jsonb_build_object('error',jsonb_build_object('code','FORBIDDEN','message','Operation requires the owner workspace','retryable',false));
 end if;
 if p_operation like 'notifications.%' then return crm_private.notification_operation(auth.uid(),p_operation,p_input);end if;
 if p_operation like 'automation.%' then
  perform crm_private.automation_guard(auth.uid(),p_operation,p_input);
  return crm_private.automation_operation(auth.uid(),p_operation,p_input);
 end if;
 if p_operation='jobs.list' then return crm_private.jobs_page(auth.uid(),p_input);end if;
 if p_operation in ('contacts.preview_erasure','contacts.erase') then return crm_private.contact_erasure(auth.uid(),p_operation,p_input);end if;
 if p_operation='outreach.cancel' then return crm_private.outreach_cancel(auth.uid(),p_input);end if;
 result=crm_private.operation(auth.uid(),p_operation,p_input);
 if p_operation='dashboard.summary' and not result ? 'error' then result=result||jsonb_build_object('recent_updates',crm_private.dashboard_recent(auth.uid()),'workspace',crm_private.dashboard_workspace(auth.uid()));end if;
 if p_operation='jobs.get' and result ? 'id' and not result ? 'error' then
  result=result||jsonb_build_object('triage',crm_private.job_triage(auth.uid(),(result->>'id')::uuid));
 end if;
 return result;
exception when sqlstate 'CR001' then return jsonb_build_object('error',SQLERRM::jsonb);
 when invalid_text_representation then return jsonb_build_object('error',jsonb_build_object('code','UNAUTHENTICATED','message','Invalid session','retryable',false));
end $$;
