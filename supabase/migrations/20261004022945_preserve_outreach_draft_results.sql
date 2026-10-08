-- Outreach records have an error column; a nullable column is not a domain error envelope.
do $$
declare definition text; old text=$fragment$if r ? 'error' then perform crm_private.fail(r->'error'->>'code'$fragment$;
begin
 definition=pg_get_functiondef('crm_private.automation_operation(uuid,text,jsonb)'::regprocedure);
 if strpos(definition,old)=0 then raise exception 'Automation dispatcher differs; review before upgrading';end if;
 definition=replace(definition,old,$fragment$if jsonb_typeof(r->'error')='object' then perform crm_private.fail(r->'error'->>'code'$fragment$);
 execute definition;
end $$;
