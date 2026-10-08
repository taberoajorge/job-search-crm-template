-- A known version conflict needs a new explicit intent, never a rewritten receipt.
do $$ declare definition text;needle text;begin
 definition=pg_get_functiondef('crm_private.enqueue_interview(uuid,uuid,text,jsonb,boolean)'::regprocedure);
 needle=E' if found then\n  if w.state';
 if strpos(definition,needle)=0 then raise exception 'Interview coalescing contract missing';end if;
 definition=replace(definition,needle,E' if found and manual and w.state=\'blocked\' and coalesce(w.error,\'\') like \'%CONFLICT%\' then\n  update public.automation_work set state=\'cancelled\',version=version+1,updated_at=now() where id=w.id;\n  w.id=null;\n end if;\n if w.id is not null then\n  if w.state');
 execute definition;
 definition=pg_get_functiondef('crm_private.automation_operation(uuid,text,jsonb)'::regprocedure);
 needle=E' if op=\'automation.claim\' then';
 if strpos(definition,needle)=0 then raise exception 'Interview worker version fence missing';end if;
 definition=replace(definition,needle,E' if op=\'automation.claim\' then\n  if input ? \'content_version\' and input->\'content_version\' is distinct from \'2\'::jsonb then perform crm_private.fail(\'VALIDATION_ERROR\',\'Unsupported worker content version\');end if;');
 execute definition;
end $$;
