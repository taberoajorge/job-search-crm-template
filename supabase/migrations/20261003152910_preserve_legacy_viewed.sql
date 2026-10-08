-- A historical viewed boolean does not imply a trustworthy viewing timestamp.
alter table public.jobs add column viewed boolean not null default false;
create function crm_private.sync_job_viewed() returns trigger language plpgsql set search_path='' as $$
begin
 if new.viewed_at is not null then new.viewed=true; end if;
 return new;
end $$;
revoke all on function crm_private.sync_job_viewed() from public,anon,authenticated;
create trigger sync_job_viewed before insert or update on public.jobs for each row execute function crm_private.sync_job_viewed();
update public.jobs set viewed=true where viewed_at is not null and not viewed;
alter table public.jobs add constraint jobs_view_timestamp_requires_viewed check(viewed_at is null or viewed);

create or replace function crm_private.editable(entity text) returns text[] language sql immutable set search_path='' as $$
 select case entity
 when 'companies' then array['name','domain','website_url','linkedin_url','type','product','archived_at']
 when 'sources' then array['name','kind','url']
 when 'jobs' then array['company_id','title','stage','source_id','source_posting_id','posting_url','description_summary','salary_text','salary_min','salary_max','currency','location','fit_score','fit_raw','posted_on','applied_at','applied_date_precision','notes','viewed','viewed_at','resume_id']
 when 'contacts' then array['company_id','job_id','name','role','email','linkedin_url','status','priority','invite_at','last_interacted_at','draft_note','draft_message','queued_at','resume_id','notes','archived_at']
 when 'interviews' then array['job_id','scheduled_at','timezone','state','interviewer_ids','interviewer_notes','meeting_url','notes','next_step']
 when 'outreach_events' then array['contact_id','job_id','channel','kind','state','body','scheduled_for','occurred_at','resume_id','external_ref','error']
 when 'resumes' then array['label','country','track','storage_path','checksum','media_type','active']
 when 'verifications' then array['job_id','company_id','status','checked_at','evidence_url','source_id','notes']
 else array[]::text[] end
$$;

create or replace function crm_private.validate(input jsonb,allowed text[]) returns void language plpgsql set search_path='' as $$
declare k text; v jsonb;
begin
 if jsonb_typeof(input)<>'object' or input is null then perform crm_private.fail('VALIDATION_ERROR','Input must be an object'); end if;
 for k,v in select * from jsonb_each(input) loop
  if not k=any(allowed) then perform crm_private.fail('VALIDATION_ERROR','Unknown field',k); end if;
  if v='null'::jsonb then
   if k=any(array['id','idempotency_key','expected_version','source_version','target_version','task_id','name','title','stage','status','kind','channel','state','body','notes','draft_note','draft_message','label','timezone','interviewer_ids','interviewer_notes','checked_at','storage_path','checksum','media_type','active','viewed','confirmation','payload','records','entity_type','legacy_id','data','import_namespace','limit','cursor','query','reason','confirmation_ref','endpoint','p256dh','auth','occurred_at','scheduled_for','from','to']) then perform crm_private.fail('VALIDATION_ERROR','Field cannot be null',k); end if;
   continue;
  end if;
  if k in ('id','company_id','job_id','contact_id','resume_id','source_id','target_id','task_id','idempotency_key') then
   if jsonb_typeof(v)<>'string' or (v#>>'{}') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then perform crm_private.fail('VALIDATION_ERROR','Expected UUID',k); end if;
  elsif k in ('expected_version','source_version','target_version','limit','priority') then
   if jsonb_typeof(v)<>'number' or (v#>>'{}') !~ '^[0-9]+$' or (v#>>'{}')::numeric<1 then perform crm_private.fail('VALIDATION_ERROR','Expected positive integer',k); end if;
  elsif k in ('salary_min','salary_max','fit_score') then
   if jsonb_typeof(v)<>'number' then perform crm_private.fail('VALIDATION_ERROR','Expected number',k); end if;
  elsif k in ('active','viewed','confirmation') then
   if jsonb_typeof(v)<>'boolean' then perform crm_private.fail('VALIDATION_ERROR','Expected boolean',k); end if;
  elsif k='interviewer_ids' then
   if jsonb_typeof(v)<>'array' or jsonb_array_length(v)>100 then perform crm_private.fail('VALIDATION_ERROR','Expected at most 50 interviewer IDs',k); end if;
  elsif k in ('payload','records','embedding','data') then null;
  else
   if jsonb_typeof(v)<>'string' then perform crm_private.fail('VALIDATION_ERROR','Expected string',k); end if;
  end if;
  if jsonb_typeof(v)='string' and length(v#>>'{}')>100000 then perform crm_private.fail('VALIDATION_ERROR','Text exceeds 100000 characters',k); end if;
  if k in ('name','title','label','reason','confirmation_ref','import_namespace','legacy_id','query','device_label') and length(v#>>'{}')>(case when k in ('reason','confirmation_ref') then 2000 else 500 end) then perform crm_private.fail('VALIDATION_ERROR','Text exceeds field limit',k); end if;
  if k='model' and length(v#>>'{}')>200 then perform crm_private.fail('VALIDATION_ERROR','Model name exceeds 200 characters',k); end if;
  if k='draft_note' and length(v#>>'{}')>300 then perform crm_private.fail('VALIDATION_ERROR','Draft note exceeds 300 characters',k); end if;
  if k in ('applied_at','viewed_at','invite_at','last_interacted_at','queued_at','archived_at','scheduled_at','scheduled_for','occurred_at','checked_at','from','to') and (v#>>'{}') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' then perform crm_private.fail('VALIDATION_ERROR','Use an ISO timestamp with timezone',k); end if;
  if k='posted_on' and (v#>>'{}') !~ '^\d{4}-\d{2}-\d{2}$' then perform crm_private.fail('VALIDATION_ERROR','Use an ISO date',k); end if;
  if k='currency' and (v#>>'{}') !~ '^[A-Z]{3}$' then perform crm_private.fail('VALIDATION_ERROR','Use three-letter uppercase currency',k); end if;
  if k='email' and (v#>>'{}') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then perform crm_private.fail('VALIDATION_ERROR','Invalid email address',k); end if;
  if k='stage' and (v#>>'{}') not in ('radar','review','ready','applied','invited','messaged','replied','interview','offer','rejected','archived') then perform crm_private.fail('VALIDATION_ERROR','Invalid job stage',k); end if;
  if k='fit_score' and (v#>>'{}')::numeric not between 0 and 10 then perform crm_private.fail('VALIDATION_ERROR','Fit score must be 0..10',k); end if;
  if k in ('salary_min','salary_max') and (v#>>'{}')::numeric<0 then perform crm_private.fail('VALIDATION_ERROR','Salary must be nonnegative',k); end if;
  if k='applied_date_precision' and (v#>>'{}') not in ('day','instant','approximate') then perform crm_private.fail('VALIDATION_ERROR','Invalid date precision',k); end if;
  if k in ('url','website_url','linkedin_url','posting_url','meeting_url','evidence_url','endpoint') and (v#>>'{}') !~* '^https?://[^[:space:]]+$' then perform crm_private.fail('VALIDATION_ERROR','Expected HTTP(S) URL',k); end if;
 end loop;
end $$;

