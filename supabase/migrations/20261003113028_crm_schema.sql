-- No production owner is seeded: provision privately after review.
revoke create on schema public from public,anon,authenticated;
create schema if not exists crm_private;
revoke all on schema crm_private from public, anon, authenticated;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create table crm_private.settings(singleton boolean primary key default true check(singleton), owner_id uuid not null references auth.users(id), mcp_resource text not null);
revoke all on crm_private.settings from public, anon, authenticated;
create function crm_private.is_owner() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from crm_private.settings where owner_id=(select auth.uid()))
$$;
revoke all on function crm_private.is_owner() from public;
grant usage on schema crm_private to authenticated;
grant execute on function crm_private.is_owner() to authenticated;
create table public.companies (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), version bigint not null default 1 check(version > 0), unique(user_id,id), name text not null check(length(trim(name))>0), domain text, website_url text, linkedin_url text, type text, product text, archived_at timestamptz);
alter table public.companies enable row level security;
create policy owner_read on public.companies for select to authenticated using (user_id=(select auth.uid()) and (select crm_private.is_owner()));
revoke all on public.companies from public,anon,authenticated;
grant select on public.companies to authenticated;
create index companies_owner_page on public.companies(user_id,created_at,id);
create table public.sources (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), version bigint not null default 1 check(version > 0), unique(user_id,id), name text not null check(length(trim(name))>0), kind text not null check(kind in ('ats','recruiter','referral','aggregator','manual')), url text);
alter table public.sources enable row level security;
create policy owner_read on public.sources for select to authenticated using (user_id=(select auth.uid()) and (select crm_private.is_owner()));
revoke all on public.sources from public,anon,authenticated;
grant select on public.sources to authenticated;
create index sources_owner_page on public.sources(user_id,created_at,id);
create table public.resumes (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), version bigint not null default 1 check(version > 0), unique(user_id,id), label text not null, country text, track text, storage_path text not null unique check(split_part(storage_path,'/',1)=user_id::text), checksum text not null check(checksum ~ '^[a-f0-9]{64}$'), media_type text not null check(media_type in ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document')), active boolean not null default true);
alter table public.resumes enable row level security;
create policy owner_read on public.resumes for select to authenticated using (user_id=(select auth.uid()) and (select crm_private.is_owner()));
revoke all on public.resumes from public,anon,authenticated;
create index resumes_owner_page on public.resumes(user_id,created_at,id);
create table public.jobs (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), version bigint not null default 1 check(version > 0), unique(user_id,id), company_id uuid not null, title text not null check(length(trim(title))>0), stage text not null default 'radar' check(stage in ('radar','review','ready','applied','invited','messaged','replied','interview','offer','rejected','archived')), source_id uuid, source_posting_id text, posting_url text, description_summary text, salary_text text, salary_min numeric, salary_max numeric, currency text, location text, fit_score numeric check(fit_score between 0 and 10), fit_raw text, posted_on date, applied_at timestamptz, applied_date_precision text check(applied_date_precision in ('day','instant','approximate')), notes text not null default '', viewed_at timestamptz, resume_id uuid, check(salary_min is null or salary_min>=0), constraint jobs_salary_bounds check(salary_max is null or (salary_max>=0 and (salary_min is null or salary_max>=salary_min))), constraint jobs_money_currency check((salary_min is null and salary_max is null) or (currency is not null and currency ~ '^[A-Z]{3}$')));
alter table public.jobs enable row level security;
create policy owner_read on public.jobs for select to authenticated using (user_id=(select auth.uid()) and (select crm_private.is_owner()));
revoke all on public.jobs from public,anon,authenticated;
grant select on public.jobs to authenticated;
create index jobs_owner_page on public.jobs(user_id,created_at,id);
create table public.contacts (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), version bigint not null default 1 check(version > 0), unique(user_id,id), company_id uuid not null, job_id uuid, name text not null check(length(trim(name))>0), role text, email text, linkedin_url text, status text not null default 'uncontacted' check(status in ('uncontacted','invited','connected','messaged','replied','interview','no_response')), priority integer check(priority>0), invite_at timestamptz, last_interacted_at timestamptz, draft_note text not null default '' check(length(draft_note)<=300), draft_message text not null default '', queued_at timestamptz, resume_id uuid, notes text not null default '', archived_at timestamptz);
alter table public.contacts enable row level security;
create policy owner_read on public.contacts for select to authenticated using (user_id=(select auth.uid()) and (select crm_private.is_owner()));
revoke all on public.contacts from public,anon,authenticated;
grant select on public.contacts to authenticated;
create index contacts_owner_page on public.contacts(user_id,created_at,id);
create table public.outreach_events (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), version bigint not null default 1 check(version > 0), unique(user_id,id), contact_id uuid, job_id uuid, channel text not null check(channel in ('manual','email','linkedin')), kind text not null check(kind in ('application','invitation','message','followup','response')), state text not null default 'draft' check(state in ('draft','queued','sent','failed','responded','cancelled')), body text not null, scheduled_for timestamptz, occurred_at timestamptz, resume_id uuid, external_ref text, error text, check(contact_id is not null or job_id is not null));
alter table public.outreach_events enable row level security;
create policy owner_read on public.outreach_events for select to authenticated using (user_id=(select auth.uid()) and (select crm_private.is_owner()));
revoke all on public.outreach_events from public,anon,authenticated;
grant select on public.outreach_events to authenticated;
create index outreach_events_owner_page on public.outreach_events(user_id,created_at,id);
create table public.interviews (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), version bigint not null default 1 check(version > 0), unique(user_id,id), job_id uuid not null, scheduled_at timestamptz, timezone text not null, state text not null check(state in ('planned','completed','cancelled')), interviewer_ids uuid[] not null default '{}', interviewer_notes text not null default '', meeting_url text, notes text not null default '', next_step text);
alter table public.interviews enable row level security;
create policy owner_read on public.interviews for select to authenticated using (user_id=(select auth.uid()) and (select crm_private.is_owner()));
revoke all on public.interviews from public,anon,authenticated;
grant select on public.interviews to authenticated;
create index interviews_owner_page on public.interviews(user_id,created_at,id);
create table public.verifications (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), version bigint not null default 1 check(version > 0), unique(user_id,id), job_id uuid, company_id uuid, status text not null check(status in ('pending','partial','confirmed','ambiguous','closed')), checked_at timestamptz not null, evidence_url text, source_id uuid, notes text not null, check((job_id is null) <> (company_id is null)));
alter table public.verifications enable row level security;
create policy owner_read on public.verifications for select to authenticated using (user_id=(select auth.uid()) and (select crm_private.is_owner()));
revoke all on public.verifications from public,anon,authenticated;
grant select on public.verifications to authenticated;
create index verifications_owner_page on public.verifications(user_id,created_at,id);
create table public.audit_events (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), version bigint not null default 1 check(version > 0), unique(user_id,id), entity_type text not null, entity_id uuid not null, action text not null, actor_subject text not null, actor_kind text not null check(actor_kind in ('user','worker')), request_id uuid not null, before jsonb, after jsonb);
alter table public.audit_events enable row level security;
create policy owner_read on public.audit_events for select to authenticated using (user_id=(select auth.uid()) and (select crm_private.is_owner()));
revoke all on public.audit_events from public,anon,authenticated;
grant select on public.audit_events to authenticated;
create index audit_events_owner_page on public.audit_events(user_id,created_at,id);
create table public.mutation_receipts (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), version bigint not null default 1 check(version > 0), unique(user_id,id), idempotency_key uuid not null, operation text not null, payload_hash text not null, response jsonb not null, completed_at timestamptz not null default now(), unique(user_id,idempotency_key));
alter table public.mutation_receipts enable row level security;
create policy owner_read on public.mutation_receipts for select to authenticated using (user_id=(select auth.uid()) and (select crm_private.is_owner()));
revoke all on public.mutation_receipts from public,anon,authenticated;
create index mutation_receipts_owner_page on public.mutation_receipts(user_id,created_at,id);
create table public.crm_jobs (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), version bigint not null default 1 check(version > 0), unique(user_id,id), kind text not null check(kind in ('bulk_import','embed_records')), state text not null default 'queued' check(state in ('queued','running','completed','failed','cancelled')), payload jsonb not null, result jsonb, error jsonb, attempts integer not null default 0 check(attempts between 0 and 3), lease_until timestamptz, lease_token uuid, next_attempt_at timestamptz not null default now(), request_id uuid not null);
alter table public.crm_jobs enable row level security;
create policy owner_read on public.crm_jobs for select to authenticated using (user_id=(select auth.uid()) and (select crm_private.is_owner()));
revoke all on public.crm_jobs from public,anon,authenticated;
grant select on public.crm_jobs to authenticated;
create index crm_jobs_owner_page on public.crm_jobs(user_id,created_at,id);
create table public.push_subscriptions (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), version bigint not null default 1 check(version > 0), unique(user_id,id), endpoint text not null, p256dh text not null, auth text not null, active boolean not null default true, device_label text, unique(user_id,endpoint));
alter table public.push_subscriptions enable row level security;
create policy owner_read on public.push_subscriptions for select to authenticated using (user_id=(select auth.uid()) and (select crm_private.is_owner()));
revoke all on public.push_subscriptions from public,anon,authenticated;
create index push_subscriptions_owner_page on public.push_subscriptions(user_id,created_at,id);
create table public.push_deliveries (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), version bigint not null default 1 check(version > 0), unique(user_id,id), crm_job_id uuid not null, subscription_id uuid not null, state text not null default 'queued' check(state in ('queued','sent','failed')), attempts integer not null default 0 check(attempts between 0 and 3), next_attempt_at timestamptz not null default now(), lease_until timestamptz, lease_token uuid, unique(crm_job_id,subscription_id));
alter table public.push_deliveries enable row level security;
create policy owner_read on public.push_deliveries for select to authenticated using (user_id=(select auth.uid()) and (select crm_private.is_owner()));
revoke all on public.push_deliveries from public,anon,authenticated;
create index push_deliveries_owner_page on public.push_deliveries(user_id,created_at,id);
create table public.legacy_links (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), version bigint not null default 1 check(version > 0), unique(user_id,id), import_namespace text not null, entity_type text not null, legacy_id text not null, entity_id uuid not null, unique(user_id,import_namespace,entity_type,legacy_id));
alter table public.legacy_links enable row level security;
create policy owner_read on public.legacy_links for select to authenticated using (user_id=(select auth.uid()) and (select crm_private.is_owner()));
revoke all on public.legacy_links from public,anon,authenticated;
grant select on public.legacy_links to authenticated;
create index legacy_links_owner_page on public.legacy_links(user_id,created_at,id);
alter table public.jobs add foreign key(user_id,company_id) references public.companies(user_id,id);
create index jobs_company_id_idx on public.jobs(user_id,company_id);
alter table public.jobs add foreign key(user_id,source_id) references public.sources(user_id,id);
create index jobs_source_id_idx on public.jobs(user_id,source_id);
alter table public.jobs add foreign key(user_id,resume_id) references public.resumes(user_id,id);
create index jobs_resume_id_idx on public.jobs(user_id,resume_id);
alter table public.contacts add foreign key(user_id,company_id) references public.companies(user_id,id);
create index contacts_company_id_idx on public.contacts(user_id,company_id);
alter table public.contacts add foreign key(user_id,job_id) references public.jobs(user_id,id);
create index contacts_job_id_idx on public.contacts(user_id,job_id);
alter table public.contacts add foreign key(user_id,resume_id) references public.resumes(user_id,id);
create index contacts_resume_id_idx on public.contacts(user_id,resume_id);
alter table public.outreach_events add foreign key(user_id,contact_id) references public.contacts(user_id,id);
create index outreach_events_contact_id_idx on public.outreach_events(user_id,contact_id);
alter table public.outreach_events add foreign key(user_id,job_id) references public.jobs(user_id,id);
create index outreach_events_job_id_idx on public.outreach_events(user_id,job_id);
alter table public.outreach_events add foreign key(user_id,resume_id) references public.resumes(user_id,id);
create index outreach_events_resume_id_idx on public.outreach_events(user_id,resume_id);
alter table public.interviews add foreign key(user_id,job_id) references public.jobs(user_id,id);
create index interviews_job_id_idx on public.interviews(user_id,job_id);
alter table public.verifications add foreign key(user_id,job_id) references public.jobs(user_id,id);
create index verifications_job_id_idx on public.verifications(user_id,job_id);
alter table public.verifications add foreign key(user_id,company_id) references public.companies(user_id,id);
create index verifications_company_id_idx on public.verifications(user_id,company_id);
alter table public.verifications add foreign key(user_id,source_id) references public.sources(user_id,id);
create index verifications_source_id_idx on public.verifications(user_id,source_id);
alter table public.push_deliveries add foreign key(user_id,crm_job_id) references public.crm_jobs(user_id,id);
create index push_deliveries_crm_job_id_idx on public.push_deliveries(user_id,crm_job_id);
alter table public.push_deliveries add foreign key(user_id,subscription_id) references public.push_subscriptions(user_id,id);
create index push_deliveries_subscription_id_idx on public.push_deliveries(user_id,subscription_id);

create unique index jobs_authoritative_identity on public.jobs(user_id,source_id,source_posting_id) where source_id is not null and source_posting_id is not null;
create index jobs_search on public.jobs using gin(to_tsvector('simple',title||' '||coalesce(description_summary,'')||' '||notes));
create index companies_name_trgm on public.companies using gin(name extensions.gin_trgm_ops);
create index contacts_name_trgm on public.contacts using gin(name extensions.gin_trgm_ops);
create index crm_jobs_claim on public.crm_jobs(next_attempt_at) where state in ('queued','running');
create index push_deliveries_claim on public.push_deliveries(next_attempt_at) where state='queued';
-- ponytail: arrays keep this personal CRM portable; move to pgvector indexed vectors when volume warrants it.
create table crm_private.embeddings(user_id uuid not null references auth.users(id), entity_type text not null check(entity_type in ('jobs','companies','contacts')), entity_id uuid not null, vector double precision[] not null, model text not null, source_version bigint not null, primary key(user_id,entity_type,entity_id), check(cardinality(vector) between 1 and 4096));
alter table crm_private.embeddings enable row level security;
create function crm_private.guard_record() returns trigger language plpgsql set search_path='' as $$
declare x uuid;
begin
 if TG_OP='UPDATE' then
  if new.id<>old.id or new.user_id<>old.user_id or new.created_at<>old.created_at then raise exception using errcode='22023', message='Immutable identity'; end if;
  if TG_TABLE_NAME in ('verifications','audit_events','mutation_receipts','legacy_links') then raise exception using errcode='22023',message='Append-only record'; end if;
  if TG_TABLE_NAME='resumes' and (to_jsonb(new)-array['active','updated_at','version'])<>(to_jsonb(old)-array['active','updated_at','version']) then raise exception using errcode='22023',message='Immutable resume'; end if;
  new.version=old.version+1; new.updated_at=now();
 end if;
 if TG_TABLE_NAME='interviews' then
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=new.timezone) then raise exception using errcode='22023',message='Invalid timezone'; end if;
  foreach x in array new.interviewer_ids loop
   if not exists(select 1 from public.contacts where id=x and user_id=new.user_id) then raise exception using errcode='23503',message='Invalid interviewer reference'; end if;
  end loop;
 end if;
 return new;
end $$;
create function crm_private.audit_record() returns trigger language plpgsql set search_path='' as $$
begin
 insert into public.audit_events(user_id,entity_type,entity_id,action,actor_subject,actor_kind,request_id,before,after)
 values(new.user_id,TG_TABLE_NAME,new.id,coalesce(nullif(current_setting('crm.operation',true),''),lower(TG_OP)),case when current_setting('crm.actor_kind',true)='worker' then 'crm_worker' else new.user_id::text end,
 coalesce(nullif(current_setting('crm.actor_kind',true),''),'user'),coalesce(nullif(current_setting('crm.request_id',true),'')::uuid,gen_random_uuid()),
 case when TG_OP='UPDATE' then to_jsonb(old)-array['storage_path','endpoint','p256dh','auth','payload'] else null end,
 (to_jsonb(new)-array['storage_path','endpoint','p256dh','auth','payload'])||case when nullif(current_setting('crm.reason',true),'') is not null then jsonb_build_object('reason',current_setting('crm.reason',true)) else '{}'::jsonb end);
 return new;
end $$;
create trigger guard_record before insert or update on public.companies for each row execute function crm_private.guard_record();
create trigger audit_record after insert or update on public.companies for each row execute function crm_private.audit_record();
create trigger guard_record before insert or update on public.sources for each row execute function crm_private.guard_record();
create trigger audit_record after insert or update on public.sources for each row execute function crm_private.audit_record();
create trigger guard_record before insert or update on public.resumes for each row execute function crm_private.guard_record();
create trigger audit_record after insert or update on public.resumes for each row execute function crm_private.audit_record();
create trigger guard_record before insert or update on public.jobs for each row execute function crm_private.guard_record();
create trigger audit_record after insert or update on public.jobs for each row execute function crm_private.audit_record();
create trigger guard_record before insert or update on public.contacts for each row execute function crm_private.guard_record();
create trigger audit_record after insert or update on public.contacts for each row execute function crm_private.audit_record();
create trigger guard_record before insert or update on public.outreach_events for each row execute function crm_private.guard_record();
create trigger audit_record after insert or update on public.outreach_events for each row execute function crm_private.audit_record();
create trigger guard_record before insert or update on public.interviews for each row execute function crm_private.guard_record();
create trigger audit_record after insert or update on public.interviews for each row execute function crm_private.audit_record();
create trigger guard_record before insert or update on public.verifications for each row execute function crm_private.guard_record();
create trigger audit_record after insert or update on public.verifications for each row execute function crm_private.audit_record();
create trigger guard_record before insert or update on public.audit_events for each row execute function crm_private.guard_record();
create trigger guard_record before insert or update on public.mutation_receipts for each row execute function crm_private.guard_record();
create trigger guard_record before insert or update on public.crm_jobs for each row execute function crm_private.guard_record();
create trigger audit_record after insert or update on public.crm_jobs for each row execute function crm_private.audit_record();
create trigger guard_record before insert or update on public.push_subscriptions for each row execute function crm_private.guard_record();
create trigger audit_record after insert or update on public.push_subscriptions for each row execute function crm_private.audit_record();
create trigger guard_record before insert or update on public.push_deliveries for each row execute function crm_private.guard_record();
create trigger guard_record before insert or update on public.legacy_links for each row execute function crm_private.guard_record();

revoke all on all functions in schema crm_private from public,anon,authenticated;
grant execute on function crm_private.is_owner() to authenticated;
grant select on public.mutation_receipts to authenticated;
grant select(id,user_id,created_at,updated_at,version,label,country,track,checksum,media_type,active) on public.resumes to authenticated;
-- Publish only authorized metadata tables; Storage locations and push keys stay private.
do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then
  alter publication supabase_realtime add table public.jobs,public.contacts,public.companies,public.outreach_events,public.interviews,public.crm_jobs,public.verifications,public.sources,public.resumes(id,user_id,created_at,updated_at,version,label,country,track,checksum,media_type,active);
 end if;
end $$;
