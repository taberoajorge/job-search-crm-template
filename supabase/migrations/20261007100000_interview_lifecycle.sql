-- Interview preparation follows the vacancy: closed vacancies stop it, unrelated edits do not buy research,
-- a retry-limit failure waits for the owner and a contact-confirmed interview starts it.
do $$declare definition text;
 gate_needle text=$n$ if not found then perform crm_private.fail('NOT_FOUND','Vacancy not found');end if;$n$;
 lookup_needle text=$n$kind='interview' and checkpoint->>'content_version'='2' and state in ('queued','running','waiting','blocked') for update limit 1;$n$;
 failed_needle text=$n$  if w.state<>'running' and (manual or w.policy_version<>p.version) then$n$;
 fresh_needle text=$n$ and k.job_version=j.version and k.resume_version=r.version and r.active and k.company_version=c.version) then return null;end if;$n$;
begin
 definition=pg_get_functiondef('crm_private.enqueue_interview(uuid,uuid,text,jsonb,boolean)'::regprocedure);
 if strpos(definition,$m$j.stage in ('rejected','archived') and not manual$m$)>0 then return;end if;
 if strpos(definition,gate_needle)=0 or strpos(definition,lookup_needle)=0 or strpos(definition,failed_needle)=0 or strpos(definition,fresh_needle)=0 then raise exception 'Review interview enqueue before upgrading';end if;
 definition=replace(definition,gate_needle,gate_needle||$r$
 if j.stage in ('rejected','archived') and not manual then
  update public.automation_interview_intents set active=false where user_id=owner and job_id=job;
  update public.automation_work set state='cancelled',version=version+1,updated_at=now() where user_id=owner and job_id=job and kind='interview' and state in ('queued','waiting','blocked') and checkpoint->>'provider_id' is null;
  return null;
 end if;$r$);
 definition=replace(definition,lookup_needle,$r$kind='interview' and checkpoint->>'content_version'='2' and (state in ('queued','running','waiting','blocked')
  or state='failed' and error='RETRY_LIMIT' and not manual and not exists(select 1 from public.automation_packs k where k.user_id=owner and k.job_id=job and k.created_at>automation_work.created_at))
 order by state='failed',created_at desc for update limit 1;$r$);
 definition=replace(definition,failed_needle,$r$  if w.state='failed' then return w.id;end if;
$r$||failed_needle);
 definition=replace(definition,fresh_needle,$r$ and k.resume_version=r.version and r.active) then return null;end if;$r$);
 execute definition;
 definition=pg_get_functiondef('crm_private.capture_interview_intent()'::regprocedure);
 if strpos(definition,$n$in ('jobs.transition','jobs.upsert') and new.stage='interview'$n$)=0 then raise exception 'Review interview capture before upgrading';end if;
 definition=replace(definition,$n$in ('jobs.transition','jobs.upsert') and new.stage='interview'$n$,$r$in ('jobs.transition','jobs.upsert','contacts.upsert') and new.stage='interview'$r$);
 execute definition;
end $$;
