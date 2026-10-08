-- Explicit owner retry preserves model sessions and mutation receipts; paid creates are excluded.
do $$
declare definition text;old_fields text='else array[''idempotency_key'',''profile_id''] end';marker text='  if op=''automation.trigger'' and not (p.policy->>''enabled'')::boolean then';
begin
 definition=pg_get_functiondef('crm_private.automation_operation(uuid,text,jsonb)'::regprocedure);
 if strpos(definition,old_fields)=0 or strpos(definition,marker)=0 then raise exception 'Automation dispatcher differs; review before upgrading';end if;
 definition=replace(definition,old_fields,'else array[''idempotency_key'',''profile_id'',''retry_failed''] end');
 definition=replace(definition,marker,$patch$
  if input ? 'retry_failed' and jsonb_typeof(input->'retry_failed')<>'boolean' then perform crm_private.fail('VALIDATION_ERROR','Expected retry boolean');end if;
  if op='automation.trigger' and input->'retry_failed'='true'::jsonb and (p.policy->>'enabled')::boolean then
   update public.automation_work set state='queued',attempts=0,error=null,version=version+1,next_attempt_at=now(),updated_at=now()
   where user_id=owner and policy_version=p.version and kind in ('prepare','interview','discovery') and state in ('waiting','blocked','failed') and error in ('RETRY_LIMIT','MODEL_INTERRUPTED','MODEL_SCHEMA_INVALID');
  end if;
$patch$||marker);
 execute definition;
end $$;
