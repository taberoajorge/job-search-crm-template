-- Owner-scoped contact research covers radar and review, even when CV triage needs a human.
do $$
declare definition text;marker text='   for pr in select * from public.automation_profiles where user_id=owner and next_revalidation_at<=now() for update loop';
begin
 definition=pg_get_functiondef('crm_private.automation_operation(uuid,text,jsonb)'::regprocedure);
 if strpos(definition,marker)=0 then raise exception 'Automation dispatcher differs; review before upgrading';end if;
 definition=replace(definition,marker,$patch$
   for rowjob in select j.* from public.jobs j where j.user_id=owner and j.stage in ('radar','review') and p.policy->'sources' ? 'exa'
    and not exists(select 1 from public.contacts c where c.user_id=owner and c.job_id=j.id and c.linkedin_url is not null)
    and not exists(select 1 from public.automation_work q where q.user_id=owner and q.job_id=j.id and q.kind in ('research','prepare','interview') and q.state in ('queued','running','waiting'))
    and not exists(select 1 from public.automation_work q where q.user_id=owner and q.job_id=j.id and q.checkpoint->>'contact_only'='true' and (q.created_at>now()-interval '24 hours' or q.state='completed' and q.checkpoint->>'contact_job_version'=j.version::text))
    order by j.created_at,j.id loop
    select * into pr from public.automation_profiles where user_id=owner order by (resume_id=rowjob.resume_id) desc nulls last,id limit 1;
    if found then insert into public.automation_work(user_id,profile_id,policy_version,kind,job_id,checkpoint)
     values(owner,pr.id,p.version,'research',rowjob.id,jsonb_build_object('phase','contact-backlog','contact_only',true,'contact_job_version',rowjob.version));end if;
   end loop;
$patch$||marker);
 execute definition;
end $$;
