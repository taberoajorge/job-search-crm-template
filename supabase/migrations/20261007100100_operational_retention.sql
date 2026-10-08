-- Polling receipts (heartbeat, claim, checkpoint) only protect replays within minutes; business effects keep theirs.
create or replace function crm_private.prune_receipts() returns void language sql set search_path='' as $$
 delete from public.mutation_receipts where operation in ('automation.heartbeat','automation.claim','automation.checkpoint') and completed_at<now()-interval '14 days';
$$;
revoke all on function crm_private.prune_receipts() from public,anon,authenticated,crm_worker;

-- Retention jobs are idempotent by name and also installed by the operator step, so a fresh or rebuilt project gets them.
create or replace function crm_private.schedule_retention() returns void language plpgsql set search_path='' as $$
begin
 if to_regprocedure('cron.schedule(text,text,text)') is null then return;end if;
 perform cron.schedule('crm-audit-retention','17 3 * * *','select crm_private.minimize_audit_payloads();');
 perform cron.schedule('crm-notification-retention','18 3 * * *','select crm_private.notification_prune();');
 perform cron.schedule('crm-receipt-retention','19 3 * * *','select crm_private.prune_receipts();');
 perform cron.schedule('crm-cron-history-retention','20 3 * * *',$job$delete from cron.job_run_details where end_time<now()-interval '7 days'$job$);
end $$;
revoke all on function crm_private.schedule_retention() from public,anon,authenticated,crm_worker;
select crm_private.schedule_retention();
do $$declare definition text;needle text=E'timeout_milliseconds:=30000);\n $job$);';begin
 definition=pg_get_functiondef('crm_private.install_schedule()'::regprocedure);
 if strpos(definition,'schedule_retention')>0 then return;end if;
 if strpos(definition,needle)=0 then raise exception 'Review scheduler installation before upgrading';end if;
 execute replace(definition,needle,needle||E'\n perform crm_private.schedule_retention();');
end $$;

-- Push repair covers tasks finished after the device (re)subscribed; deliveries of inactive devices never flush later.
do $$declare definition text;
 claim_needle text=$n$and j.state in ('completed','failed') on conflict(crm_job_id,subscription_id) do nothing;$n$;
 push_needle text=$n$where state='queued' and attempts>=3 and (lease_until is null or lease_until<now());$n$;
begin
 definition=pg_get_functiondef('crm_private.worker_claim()'::regprocedure);
 if strpos(definition,'j.updated_at>s.updated_at')>0 then return;end if;
 if strpos(definition,claim_needle)=0 then raise exception 'Review worker push repair before upgrading';end if;
 execute replace(definition,claim_needle,$r$and j.state in ('completed','failed') and j.updated_at>s.updated_at on conflict(crm_job_id,subscription_id) do nothing;$r$);
 definition=pg_get_functiondef('crm_private.push_claim()'::regprocedure);
 if strpos(definition,push_needle)=0 then raise exception 'Review push claim before upgrading';end if;
 execute replace(definition,push_needle,$r$where state='queued' and (attempts>=3 or not exists(select 1 from public.push_subscriptions active_device where active_device.user_id=push_deliveries.user_id and active_device.id=push_deliveries.subscription_id and active_device.active)) and (lease_until is null or lease_until<now());$r$);
end $$;

-- Task lease credentials stay server-side; Realtime only signals task changes, without payloads or results.
revoke select on public.crm_jobs from authenticated;
grant select(id,user_id,created_at,updated_at,version,kind,state,payload,result,error,attempts,next_attempt_at,request_id) on public.crm_jobs to authenticated;
do $$ begin
 if exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='crm_jobs') then
  alter publication supabase_realtime drop table public.crm_jobs;
  alter publication supabase_realtime add table public.crm_jobs(id,user_id,created_at,updated_at,version,kind,state,attempts,next_attempt_at);
 end if;
end $$;

