-- Closure-only consent sends closures only; other batch events need the separate live-update opt-in.
do $$declare definition text;items_needle text=E'   items=crm_private.notification_items(p.user_id,b.id,null,null,50);';counts_needle text=E' into counts from public.automation_events where user_id=p.user_id and batch_id=b.id;';begin
 definition=pg_get_functiondef('crm_private.automation_email_claim_v2()'::regprocedure);
 if strpos(definition,$m$e.kind='closed' group by e.job_id$m$)>0 then return;end if;
 if strpos(definition,items_needle)=0 or strpos(definition,counts_needle)=0 then raise exception 'Review batch email scope before upgrading';end if;
 definition=replace(definition,items_needle,E'   if s.live_email then'||items_needle||E'\n   else select coalesce(jsonb_agg(jsonb_build_object(\'job_id\',x.job_id,\'events\',x.events) order by x.job_id),\'[]\'::jsonb) into items from (\n    select e.job_id,jsonb_agg(jsonb_build_object(\'id\',e.id,\'kind\',e.kind,\'created_at\',e.created_at,\'job_version\',e.job_version,\'profile_id\',e.profile_id,\'cycle_id\',e.cycle_id,\'work_id\',e.work_id,\'snapshot\',e.snapshot) order by e.created_at,e.id) events\n    from public.automation_events e where e.user_id=p.user_id and e.batch_id=b.id and e.kind=\'closed\' group by e.job_id order by e.job_id limit 50) x;\n   end if;');
 definition=replace(definition,counts_needle,counts_needle||E'\n   if not s.live_email then counts=jsonb_build_object(\'new\',0,\'prepared\',0,\'closed\',counts->\'closed\',\'vacancies\',counts->\'closed\',\'incomplete\',0);end if;');
 execute definition;
end $$;
