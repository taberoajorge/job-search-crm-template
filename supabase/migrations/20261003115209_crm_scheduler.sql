create function crm_private.worker_renew(task uuid,token uuid) returns timestamptz language plpgsql security definer set search_path='' as $$
declare j public.crm_jobs; expiry timestamptz;
begin
 j=crm_private.worker_job(task,token);
 perform set_config('crm.actor_kind','worker',true); perform set_config('crm.request_id',j.request_id::text,true); perform set_config('crm.operation','tasks.renew',true);
 update public.crm_jobs set lease_until=now()+interval '60 seconds' where id=j.id returning lease_until into expiry;
 return expiry;
end $$;
revoke all on function crm_private.worker_renew(uuid,uuid) from public,anon,authenticated;
grant execute on function crm_private.worker_renew(uuid,uuid) to crm_worker;

-- The reviewer provisions Vault crm_worker_secret and crm_functions_url first.
-- This function never schedules until explicitly called by a database administrator.
create function crm_private.install_schedule() returns void language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from pg_available_extensions where name='pg_cron') or not exists(select 1 from pg_available_extensions where name='pg_net') then raise exception 'pg_cron and pg_net are required'; end if;
 execute 'create extension if not exists pg_cron';
 execute 'create extension if not exists pg_net with schema extensions';
 if to_regclass('vault.decrypted_secrets') is null then raise exception 'Vault is required'; end if;
 if not exists(select 1 from vault.decrypted_secrets where name='crm_worker_secret') or not exists(select 1 from vault.decrypted_secrets where name='crm_functions_url') then raise exception 'Provision worker scheduler Vault secrets first'; end if;
 perform cron.schedule('crm-worker','* * * * *',$job$
  select net.http_post(url:=(select decrypted_secret from vault.decrypted_secrets where name='crm_functions_url')||'/worker',headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='crm_worker_secret')),body:='{}'::jsonb,timeout_milliseconds:=60000);
 $job$);
 perform cron.schedule('crm-push','* * * * *',$job$
  select net.http_post(url:=(select decrypted_secret from vault.decrypted_secrets where name='crm_functions_url')||'/push',headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='crm_worker_secret')),body:='{}'::jsonb,timeout_milliseconds:=30000);
 $job$);
end $$;
revoke all on function crm_private.install_schedule() from public,anon,authenticated,crm_worker;

-- Preserve the platform auto-RLS event trigger while removing its default RPC execution grants.
do $$ begin
 if to_regprocedure('public.rls_auto_enable()') is not null then
  revoke all on function public.rls_auto_enable() from public,anon,authenticated;
 end if;
end $$;
