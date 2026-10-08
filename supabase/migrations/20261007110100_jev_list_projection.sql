-- Status and list views carry classification results, not the full criteria text; jobs.get keeps it (live-e2e-crm-mcp-004).
do $$declare definition text;
 status_needle text=$n$'jev',t.checkpoint->'jev'$n$;
 list_needle text=$n$jsonb_build_object('triage',crm_private.job_triage(owner,(item->>'id')::uuid))$n$;
begin
 definition=pg_get_functiondef('crm_private.automation_operation_before_notifications(uuid,text,jsonb)'::regprocedure);
 if strpos(definition,$m$(t.checkpoint->'jev')-'criteria'$m$)=0 then
  if strpos(definition,status_needle)=0 then raise exception 'Review automation status projection before upgrading';end if;
  execute replace(definition,status_needle,$r$'jev',(t.checkpoint->'jev')-'criteria'$r$);
 end if;
 definition=pg_get_functiondef('crm_private.jobs_page(uuid,jsonb)'::regprocedure);
 if strpos(definition,$m$#- '{jev,criteria}'$m$)=0 then
  if strpos(definition,list_needle)=0 then raise exception 'Review job list triage projection before upgrading';end if;
  execute replace(definition,list_needle,$r$jsonb_build_object('triage',crm_private.job_triage(owner,(item->>'id')::uuid) #- '{jev,criteria}')$r$);
 end if;
end $$;
