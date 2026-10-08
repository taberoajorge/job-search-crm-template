-- Realtime postgres_changes filters each event by the subscriber's column grants, not by the publication
-- column list (verified with a local probe), so the list on crm_jobs implied a protection it never added.
-- Clients receive exactly the columns they may select; lease_token and lease_until are not granted.
do $$ begin
 if exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='crm_jobs') then
  alter publication supabase_realtime drop table public.crm_jobs;
  alter publication supabase_realtime add table public.crm_jobs;
 end if;
end $$;
