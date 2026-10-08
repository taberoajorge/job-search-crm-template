create function crm_private.fail(code text,message text,field text default null,current_version bigint default null) returns void language plpgsql set search_path='' as $$
begin raise exception using errcode='CR001',message=jsonb_strip_nulls(jsonb_build_object('code',code,'message',message,'field',field,'retryable',code in ('TEMPORARY_FAILURE','RATE_LIMITED'),'current_version',current_version))::text; end $$;

create function crm_private.editable(entity text) returns text[] language sql immutable set search_path='' as $$
 select case entity
 when 'companies' then array['name','domain','website_url','linkedin_url','type','product','archived_at']
 when 'sources' then array['name','kind','url']
 when 'jobs' then array['company_id','title','stage','source_id','source_posting_id','posting_url','description_summary','salary_text','salary_min','salary_max','currency','location','fit_score','fit_raw','posted_on','applied_at','applied_date_precision','notes','viewed_at','resume_id']
 when 'contacts' then array['company_id','job_id','name','role','email','linkedin_url','status','priority','invite_at','last_interacted_at','draft_note','draft_message','queued_at','resume_id','notes','archived_at']
 when 'interviews' then array['job_id','scheduled_at','timezone','state','interviewer_ids','interviewer_notes','meeting_url','notes','next_step']
 when 'outreach_events' then array['contact_id','job_id','channel','kind','state','body','scheduled_for','occurred_at','resume_id','external_ref','error']
 when 'resumes' then array['label','country','track','storage_path','checksum','media_type','active']
 when 'verifications' then array['job_id','company_id','status','checked_at','evidence_url','source_id','notes']
 else array[]::text[] end
$$;

create function crm_private.validate(input jsonb,allowed text[]) returns void language plpgsql set search_path='' as $$
declare k text; v jsonb;
begin
 if jsonb_typeof(input)<>'object' or input is null then perform crm_private.fail('VALIDATION_ERROR','Input must be an object'); end if;
 for k,v in select * from jsonb_each(input) loop
  if not k=any(allowed) then perform crm_private.fail('VALIDATION_ERROR','Unknown field',k); end if;
  if v='null'::jsonb then
   if k=any(array['id','idempotency_key','expected_version','source_version','target_version','task_id','name','title','stage','status','kind','channel','state','body','notes','draft_note','draft_message','label','timezone','interviewer_ids','interviewer_notes','checked_at','storage_path','checksum','media_type','active','confirmation','payload','records','entity_type','legacy_id','data','import_namespace','limit','cursor','query','reason','confirmation_ref','endpoint','p256dh','auth','occurred_at','scheduled_for','from','to']) then perform crm_private.fail('VALIDATION_ERROR','Field cannot be null',k); end if;
   continue;
  end if;
  if k in ('id','company_id','job_id','contact_id','resume_id','source_id','target_id','task_id','idempotency_key') then
   if jsonb_typeof(v)<>'string' or (v#>>'{}') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then perform crm_private.fail('VALIDATION_ERROR','Expected UUID',k); end if;
  elsif k in ('expected_version','source_version','target_version','limit','priority') then
   if jsonb_typeof(v)<>'number' or (v#>>'{}') !~ '^[0-9]+$' or (v#>>'{}')::numeric<1 then perform crm_private.fail('VALIDATION_ERROR','Expected positive integer',k); end if;
  elsif k in ('salary_min','salary_max','fit_score') then
   if jsonb_typeof(v)<>'number' then perform crm_private.fail('VALIDATION_ERROR','Expected number',k); end if;
  elsif k in ('active','confirmation') then
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

create function crm_private.required(input jsonb,fields text[]) returns void language plpgsql set search_path='' as $$
declare f text;
begin foreach f in array fields loop if not input ? f or input->f='null'::jsonb or (f=any(array['name','title','reason','confirmation_ref','label','import_namespace','legacy_id']) and trim(input->>f)='') then perform crm_private.fail('VALIDATION_ERROR','Required field',f); end if; end loop; end $$;

create function crm_private.record(entity text,owner uuid,target uuid,expected bigint default null) returns jsonb language plpgsql set search_path='' as $$
declare r jsonb;
begin
 execute format('select to_jsonb(t) from public.%I t where user_id=$1 and id=$2 for update',entity) into r using owner,target;
 if r is null then perform crm_private.fail('NOT_FOUND','Record not found','id'); end if;
 if expected is not null and (r->>'version')::bigint<>expected then perform crm_private.fail('CONFLICT','Record changed; reload before saving','expected_version',(r->>'version')::bigint); end if;
 return r;
end $$;

create function crm_private.validate_entity(entity text,input jsonb,creating boolean default false) returns void language plpgsql set search_path='' as $$
begin
 perform crm_private.validate(input,crm_private.editable(entity));
 if input ? 'company_id' and input->'company_id'='null'::jsonb and entity in ('jobs','contacts') then perform crm_private.fail('VALIDATION_ERROR','Company is required','company_id'); end if;
 if input ? 'job_id' and input->'job_id'='null'::jsonb and entity='interviews' then perform crm_private.fail('VALIDATION_ERROR','Job is required','job_id'); end if;
 if entity='sources' and input ? 'kind' and input->>'kind' not in ('ats','recruiter','referral','aggregator','manual') then perform crm_private.fail('VALIDATION_ERROR','Invalid source kind','kind'); end if;
 if entity='contacts' and input ? 'status' and input->>'status' not in ('uncontacted','invited','connected','messaged','replied','interview','no_response') then perform crm_private.fail('VALIDATION_ERROR','Invalid contact status','status'); end if;
 if entity='verifications' and input ? 'status' and input->>'status' not in ('pending','partial','confirmed','ambiguous','closed') then perform crm_private.fail('VALIDATION_ERROR','Invalid verification status','status'); end if;
 if entity='outreach_events' then
  if input ? 'state' and input->>'state' not in ('draft','queued','sent','failed','responded','cancelled') then perform crm_private.fail('VALIDATION_ERROR','Invalid outreach state','state'); end if;
  if input ? 'kind' and input->>'kind' not in ('application','invitation','message','followup','response') then perform crm_private.fail('VALIDATION_ERROR','Invalid outreach kind','kind'); end if;
  if input ? 'channel' and input->>'channel' not in ('manual','email','linkedin') then perform crm_private.fail('VALIDATION_ERROR','Invalid outreach channel','channel'); end if;
 end if;
 if entity='interviews' and input ? 'state' and input->>'state' not in ('planned','completed','cancelled') then perform crm_private.fail('VALIDATION_ERROR','Invalid interview state','state'); end if;

 if creating then
  perform crm_private.required(input,case entity when 'companies' then array['name'] when 'sources' then array['name','kind'] when 'jobs' then array['company_id','title'] when 'contacts' then array['company_id','name'] when 'outreach_events' then array['channel','kind','body'] when 'interviews' then array['job_id','state','timezone'] when 'resumes' then array['label','storage_path','checksum','media_type'] when 'verifications' then array['status','checked_at','notes'] else array[]::text[] end);
 end if;
 if entity='interviews' and input ? 'timezone' and not exists(select 1 from pg_catalog.pg_timezone_names where name=input->>'timezone') then perform crm_private.fail('VALIDATION_ERROR','Invalid IANA timezone','timezone'); end if;
 if entity='verifications' and creating and ((input->>'job_id' is null)=(input->>'company_id' is null)) then perform crm_private.fail('VALIDATION_ERROR','Choose exactly one job or company','job_id'); end if;
 if entity='outreach_events' and creating and input->>'job_id' is null and input->>'contact_id' is null then perform crm_private.fail('VALIDATION_ERROR','Choose a contact or job','job_id'); end if;
end $$;

-- Only internal, validated callers can choose a table and editable columns.
create function crm_private.save(entity text,owner uuid,input jsonb,target uuid default null,expected bigint default null,create_id uuid default null) returns jsonb language plpgsql set search_path='' as $$
declare k text; columns text=''; values_sql text=''; assignments text=''; r jsonb;
begin
 perform crm_private.validate_entity(entity,input,target is null);
 if target is not null then
  if expected is null then perform crm_private.fail('VALIDATION_ERROR','Updates require expected_version','expected_version'); end if;
  perform crm_private.record(entity,owner,target,expected);
 end if;
 for k in select jsonb_object_keys(input) order by 1 loop
  columns=columns||format(',%I',k); values_sql=values_sql||format(',r.%I',k);
  assignments=assignments||case when assignments='' then '' else ',' end||format('%I=r.%I',k,k);
 end loop;
 if target is null then
  execute format('insert into public.%I as t (user_id,id%s) select $1,coalesce($3,gen_random_uuid())%s from jsonb_populate_record(null::public.%I,$2) r returning to_jsonb(t)',entity,columns,values_sql,entity) into r using owner,input,create_id;
 else
  if assignments='' then return crm_private.record(entity,owner,target); end if;
  execute format('update public.%I t set %s from jsonb_populate_record(null::public.%I,$2) r where t.user_id=$1 and t.id=$3 returning to_jsonb(t)',entity,assignments,entity) into r using owner,input,target;
 end if;
 return r;
end $$;

create function crm_private.advance_contact(owner uuid,c jsonb) returns jsonb language plpgsql set search_path='' as $$
declare j jsonb; next_stage text; stages text[]=array['radar','review','ready','applied','invited','messaged','replied','interview','offer'];
begin
 if c->>'job_id' is null then return '[]'; end if;
 j=crm_private.record('jobs',owner,(c->>'job_id')::uuid);
 next_stage=case c->>'status' when 'invited' then 'invited' when 'connected' then 'invited' when 'messaged' then 'messaged' when 'replied' then 'replied' when 'interview' then 'interview' end;
 if j->>'stage' in ('applied','invited','messaged','replied','interview') and next_stage is not null and array_position(stages,next_stage)>array_position(stages,j->>'stage') then
  j=crm_private.save('jobs',owner,jsonb_build_object('stage',next_stage),(j->>'id')::uuid,(j->>'version')::bigint);
  return jsonb_build_array(jsonb_build_object('id',j->'id','version',j->'version','stage',j->'stage'));
 end if;
 return '[]';
end $$;

create function crm_private.page(entity text,owner uuid,input jsonb) returns jsonb language plpgsql set search_path='' as $$
declare filters jsonb=input-array['cursor','limit']; fingerprint text; cur jsonb; size integer=coalesce((input->>'limit')::integer,20); rows jsonb; items jsonb; last_row jsonb; predicate text=''; k text; query text;
begin
 if size not between 1 and 50 then perform crm_private.fail('VALIDATION_ERROR','Limit must be 1..50','limit'); end if;
 fingerprint=md5(owner::text||entity||filters::text);
 if input->>'cursor' is not null then
  begin cur=convert_from(decode(input->>'cursor','base64'),'UTF8')::jsonb; exception when others then perform crm_private.fail('VALIDATION_ERROR','Invalid cursor','cursor'); end;
  if cur->>'scope' is distinct from fingerprint then perform crm_private.fail('VALIDATION_ERROR','Cursor does not match owner/filter','cursor'); end if;
 end if;
 for k in select jsonb_object_keys(filters) loop
  if k='query' then
   query=input->>'query';
   predicate=predicate||format(' and (to_tsvector(''simple'',%s) @@ plainto_tsquery(''simple'',%L) or %s ilike %L or extensions.similarity(%s,%L)>0.25)',case entity when 'jobs' then 't.title||'' ''||coalesce(t.description_summary,'''')||'' ''||t.notes||'' ''||coalesce((select co.name from public.companies co where co.user_id=t.user_id and co.id=t.company_id),'''')' when 'contacts' then 't.name||'' ''||coalesce(t.role,'''')||'' ''||coalesce((select co.name from public.companies co where co.user_id=t.user_id and co.id=t.company_id),'''')' else 't.name' end,query,case entity when 'jobs' then 't.title' else 't.name' end,'%'||query||'%',case entity when 'jobs' then 't.title' else 't.name' end,query);
  else predicate=predicate||format(' and to_jsonb(t)->>%L = %L',k,input->>k); end if;
 end loop;
 execute format('select coalesce(jsonb_agg(r order by r->>''created_at'',r->>''id''),''[]''::jsonb) from (select to_jsonb(t)%s r from public.%I t where user_id=$1%s and ($2 is null or (created_at,id)>(($2->>''created_at'')::timestamptz,($2->>''id'')::uuid)) order by created_at,id limit $3) s',case when entity='resumes' then '-''storage_path''' when entity in ('jobs','companies','contacts') then format('||jsonb_build_object(''verification'',(select to_jsonb(vf) from public.verifications vf where vf.user_id=t.user_id and %s order by checked_at desc,id desc limit 1))',case entity when 'jobs' then 'vf.job_id=t.id' when 'companies' then 'vf.company_id=t.id' else 'vf.job_id=t.job_id' end) else '' end,entity,predicate) into rows using owner,cur,size+1;
 select coalesce(jsonb_agg(value order by ordinality),'[]') into items from jsonb_array_elements(rows) with ordinality where ordinality<=size;
 last_row=items->(jsonb_array_length(items)-1);
 return jsonb_build_object('items',items,'has_more',jsonb_array_length(rows)>size,'next_cursor',case when jsonb_array_length(rows)>size then encode(convert_to(jsonb_build_object('scope',fingerprint,'created_at',last_row->>'created_at','id',last_row->>'id')::text,'UTF8'),'base64') else null end);
end $$;

-- URL equivalence is a review hint only; path/query identities are never merge keys.
create function crm_private.normalized_url(url text) returns text language plpgsql immutable set search_path='' as $$
declare core text; base text; authority text; query text; filtered text; fragment text='';
begin
 if url is null then return null; end if;
 core=split_part(url,'#',1);
 if strpos(url,'#')>0 then fragment=substr(url,strpos(url,'#')); end if;
 base=split_part(core,'?',1); authority=substring(base from '(?i)^(https?://[^/]+)');
 if authority is null then return url; end if;
 base=lower(authority)||substr(base,length(authority)+1);
 if strpos(core,'?')>0 then
  query=substr(core,strpos(core,'?')+1);
  select string_agg(param,'&' order by ordinality) into filtered from unnest(string_to_array(query,'&')) with ordinality q(param,ordinality)
  where lower(split_part(param,'=',1)) not in ('utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','fbclid','msclkid');
  if filtered is not null then base=base||'?'||filtered; elsif query='' then base=base||'?'; end if;
 end if;
 return base||fragment;
end $$;

create function crm_private.operation(owner uuid,op text,input jsonb,actor text default 'user') returns jsonb language plpgsql set search_path='' as $$
#variable_conflict use_variable
declare entity text; allowed text[]; mut boolean=false; key uuid; hash text; receipt public.mutation_receipts; result jsonb; r jsonb; before_row jsonb; c jsonb; target jsonb; changed jsonb='[]'; count_jobs integer; count_contacts integer; count_outreach integer; id uuid; expected bigint; a uuid; k text; item jsonb; stages text[]=array['radar','review','ready','applied','invited','messaged','replied','interview','offer']; error_field text;
begin
 if owner is null then perform crm_private.fail('UNAUTHENTICATED','Sign in to continue'); end if;
 if not exists(select 1 from crm_private.settings where owner_id=owner) then perform crm_private.fail('FORBIDDEN','This account is not the CRM owner'); end if;
 if input is null or jsonb_typeof(input)<>'object' or octet_length(input::text)>1048576 then perform crm_private.fail('VALIDATION_ERROR','Expected object of at most 1 MiB'); end if;
 entity=case split_part(op,'.',1) when 'outreach' then 'outreach_events' else split_part(op,'.',1) end;
 case op
 when 'jobs.list' then allowed=array['stage','company_id','query','cursor','limit'];
 when 'contacts.search' then allowed=array['query','company_id','job_id','status','cursor','limit'];
 when 'companies.list','sources.list' then allowed=array['query','cursor','limit'];
 when 'outreach.list' then allowed=array['job_id','contact_id','state','cursor','limit'];
 when 'interviews.list' then allowed=array['job_id','state','cursor','limit'];
 when 'resumes.list' then allowed=array['country','track','active','cursor','limit'];
 when 'jobs.get','resumes.get_download','companies.health','companies.preview_archive' then allowed=array['id'];
 when 'companies.preview_merge' then allowed=array['source_id','target_id'];
 when 'tasks.get' then allowed=array['task_id'];
 when 'dashboard.summary' then allowed=array['from','to'];
 when 'search.semantic' then allowed=array['entity_type','query','embedding','model','limit'];
 when 'jobs.upsert','contacts.upsert','companies.upsert','sources.upsert','interviews.upsert' then allowed=crm_private.editable(entity)||array['id','expected_version']; mut=true;
 when 'jobs.transition' then allowed=array['id','expected_version','stage','reason','applied_at']; mut=true;
 when 'companies.merge' then allowed=array['source_id','source_version','target_id','target_version','reason','confirmation']; mut=true;
 when 'companies.archive' then allowed=array['id','expected_version','reason','confirmation']; mut=true;
 when 'outreach.draft' then allowed=array['body','channel','kind','contact_id','job_id','resume_id']; mut=true;
 when 'outreach.queue' then allowed=array['id','expected_version','scheduled_for']; mut=true;
 when 'outreach.mark_sent' then allowed=array['id','expected_version','occurred_at','confirmation_ref']; mut=true;
 when 'outreach.record_response' then allowed=array['contact_id','job_id','body','occurred_at']; mut=true;
 when 'verifications.record' then allowed=crm_private.editable('verifications'); mut=true;
 when 'tasks.submit' then allowed=array['kind','payload']; mut=true;
 when 'tasks.cancel' then allowed=array['task_id','expected_version']; mut=true;
 when 'resumes.finalize' then allowed=crm_private.editable('resumes'); mut=true;
 when 'push.subscribe' then allowed=array['endpoint','p256dh','auth','device_label']; mut=true;
 when 'push.deactivate' then allowed=array['endpoint','id']; mut=true;
 else perform crm_private.fail('VALIDATION_ERROR','Unknown operation','operation');
 end case;
 if mut then allowed=allowed||array['idempotency_key']; end if;
 perform crm_private.validate(input,allowed);
 if op='contacts.search' and input ? 'status' and input->>'status' not in ('uncontacted','invited','connected','messaged','replied','interview','no_response') then perform crm_private.fail('VALIDATION_ERROR','Invalid contact status','status'); end if;
 if op='interviews.list' and input ? 'state' and input->>'state' not in ('planned','completed','cancelled') then perform crm_private.fail('VALIDATION_ERROR','Invalid interview state','state'); end if;
 if op='outreach.list' and input ? 'state' and input->>'state' not in ('draft','queued','sent','failed','responded','cancelled') then perform crm_private.fail('VALIDATION_ERROR','Invalid outreach state','state'); end if;
 if mut then
  perform crm_private.required(input,array['idempotency_key']); key=(input->>'idempotency_key')::uuid; hash=encode(extensions.digest(op||input::text,'sha256'),'hex');
  -- Serialize this owner's operations: protects cascade/version races and identical receipts.
  -- ponytail: one owner's CRM needs no per-record lock graph; split locks only if concurrent throughput matters.
  perform pg_advisory_xact_lock(hashtextextended(owner::text,0));
  select * into receipt from public.mutation_receipts where user_id=owner and idempotency_key=key;
  if found then
   if receipt.operation<>op or receipt.payload_hash<>hash then perform crm_private.fail('IDEMPOTENCY_CONFLICT','Idempotency key was used for different input','idempotency_key'); end if;
   return receipt.response;
  end if;
  perform set_config('crm.operation',op,true); perform set_config('crm.request_id',key::text,true); perform set_config('crm.actor_kind',actor,true); perform set_config('crm.reason',coalesce(input->>'reason',''),true);
 end if;
 id=(input->>'id')::uuid; expected=(input->>'expected_version')::bigint;
 if op like '%.list' or op='contacts.search' then
  result=crm_private.page(entity,owner,input);
 elsif op in ('jobs.upsert','contacts.upsert','companies.upsert','sources.upsert','interviews.upsert') then
  if id is null then
   perform crm_private.required(input,case entity when 'jobs' then array['company_id','title'] when 'contacts' then array['company_id','name'] when 'companies' then array['name'] when 'sources' then array['name','kind'] else array['job_id','state','timezone'] end);
  end if;
  if op='companies.upsert' and input->>'archived_at' is not null then perform crm_private.fail('VALIDATION_ERROR','Use companies.archive after a preview','archived_at'); end if;
  if op='jobs.upsert' then
   if id is null and input->>'stage' in ('rejected','archived') and actor<>'worker' then perform crm_private.fail('VALIDATION_ERROR','Create an active job, then use jobs.transition with a reason','stage'); end if;
   if id is not null and input ? 'applied_at' and input->'applied_at'='null'::jsonb then perform crm_private.fail('VALIDATION_ERROR','Use an explicit correction to preserve application evidence','applied_at'); end if;
   if id is not null and input ? 'stage' then perform crm_private.fail('VALIDATION_ERROR','Use jobs.transition for stage changes','stage'); end if;
   if id is null and input->>'stage' in ('applied','invited','messaged','replied','interview','offer') and input->>'applied_at' is null and actor<>'worker' then perform crm_private.fail('VALIDATION_ERROR','Application date is required','applied_at'); end if;
   if id is null and input->>'source_id' is not null and input->>'source_posting_id' is not null then
    select to_jsonb(j) into r from public.jobs j where user_id=owner and source_id=(input->>'source_id')::uuid and source_posting_id=input->>'source_posting_id';
   end if;
  end if;
  if r is null then r=crm_private.save(entity,owner,input-array['id','expected_version','idempotency_key'],id,expected); end if;
  result=r;
  if op='jobs.upsert' then
   -- ponytail: cap review hints at 50; jobs.list pages larger duplicate groups.
   result=r||jsonb_build_object('duplicate_hints',to_jsonb(array(select j.id from public.jobs j where j.user_id=owner and j.id<>(r->>'id')::uuid and ((j.company_id=(r->>'company_id')::uuid and lower(trim(j.title))=lower(trim(r->>'title'))) or (j.posting_url is not null and r->>'posting_url' is not null and crm_private.normalized_url(j.posting_url)=crm_private.normalized_url(r->>'posting_url'))) order by j.created_at,j.id limit 50)));
  end if;
  if op='contacts.upsert' then changed=crm_private.advance_contact(owner,r); result=jsonb_build_object('contact',r,'changed_jobs',changed); end if;
 elsif op='jobs.transition' then
  perform crm_private.required(input,array['id','expected_version','stage']); before_row=crm_private.record('jobs',owner,id,expected);
  if input->>'stage' not in ('radar','review','ready','applied','invited','messaged','replied','interview','offer','rejected','archived') then perform crm_private.fail('VALIDATION_ERROR','Invalid stage','stage'); end if;
  if before_row->>'stage' in ('offer','rejected','archived') or array_position(stages,input->>'stage')<array_position(stages,before_row->>'stage') then
   if nullif(trim(input->>'reason'),'') is null then perform crm_private.fail('VALIDATION_ERROR','Reopening or backward movement needs a reason','reason'); end if;
  end if;
  if input->>'stage' in ('applied','invited','messaged','replied','interview','offer') and coalesce(input->>'applied_at',before_row->>'applied_at') is null then perform crm_private.fail('VALIDATION_ERROR','Confirm actual application date','applied_at'); end if;
  r=crm_private.save('jobs',owner,jsonb_build_object('stage',input->'stage')||case when input ? 'applied_at' then jsonb_build_object('applied_at',input->'applied_at','applied_date_precision','instant') else '{}' end,id,expected);
  select ae.id into a from public.audit_events ae where ae.user_id=owner and entity_id=id and request_id=key order by ae.created_at desc,ae.id desc limit 1;
  result=jsonb_build_object('job',r,'audit_event_id',a);
 elsif op='jobs.get' then
  perform crm_private.required(input,array['id']); r=crm_private.record('jobs',owner,id);
  result=r||jsonb_build_object('contacts',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.contacts t where user_id=owner and job_id=id),'interviews',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.interviews t where user_id=owner and job_id=id),'verification',(select to_jsonb(t) from public.verifications t where user_id=owner and job_id=id order by checked_at desc,t.id desc limit 1));
 elsif op in ('companies.merge','companies.preview_merge') then
  perform crm_private.required(input,array['source_id','target_id']);
  if input->>'source_id'=input->>'target_id' then perform crm_private.fail('VALIDATION_ERROR','Choose two different companies','target_id'); end if;
  r=crm_private.record('companies',owner,(input->>'source_id')::uuid,(input->>'source_version')::bigint);
  target=crm_private.record('companies',owner,(input->>'target_id')::uuid,(input->>'target_version')::bigint);
  select count(*) into count_jobs from public.jobs where user_id=owner and company_id=(r->>'id')::uuid;
  select count(*) into count_contacts from public.contacts where user_id=owner and company_id=(r->>'id')::uuid;
  if op='companies.preview_merge' then result=jsonb_build_object('source_version',r->'version','target_version',target->'version','jobs',count_jobs,'contacts',count_contacts);
  else
   perform crm_private.required(input,array['source_version','target_version','reason','confirmation']);
   if input->>'confirmation'<>'true' or trim(input->>'reason')='' then perform crm_private.fail('VALIDATION_ERROR','Confirm the cascade preview and provide a reason','confirmation'); end if;
   update public.jobs set company_id=(target->>'id')::uuid where user_id=owner and company_id=(r->>'id')::uuid;
   update public.contacts set company_id=(target->>'id')::uuid where user_id=owner and company_id=(r->>'id')::uuid;
   -- Append replacement verification while preserving original provenance.
   insert into public.verifications(user_id,company_id,status,checked_at,evidence_url,source_id,notes)
    select owner,(target->>'id')::uuid,status,checked_at,evidence_url,source_id,notes from public.verifications where user_id=owner and company_id=(r->>'id')::uuid;
   perform crm_private.save('companies',owner,jsonb_build_object('archived_at',now()),(r->>'id')::uuid,(r->>'version')::bigint);
   result=crm_private.save('companies',owner,'{}',(target->>'id')::uuid,(target->>'version')::bigint);
   -- Surviving company must acquire a new version even when only its relations changed.
   update public.companies set name=name where user_id=owner and public.companies.id=(target->>'id')::uuid returning to_jsonb(public.companies.*) into result;
  end if;
 elsif op in ('companies.archive','companies.preview_archive') then
  perform crm_private.required(input,array['id']); r=crm_private.record('companies',owner,id,expected);
  select count(*) into count_jobs from public.jobs where user_id=owner and company_id=id and stage<>'archived';
  select count(*) into count_contacts from public.contacts where user_id=owner and company_id=id and archived_at is null;
  select count(*) into count_outreach from public.outreach_events o where user_id=owner and state='queued' and (scheduled_for is null or scheduled_for>now()) and (job_id in (select j.id from public.jobs j where j.user_id=owner and company_id=id) or contact_id in (select ct.id from public.contacts ct where ct.user_id=owner and company_id=id));
  if op='companies.preview_archive' then result=jsonb_build_object('version',r->'version','jobs',count_jobs,'contacts',count_contacts,'outreach',count_outreach);
  else
   perform crm_private.required(input,array['expected_version','reason','confirmation']);
   if input->>'confirmation'<>'true' or trim(input->>'reason')='' then perform crm_private.fail('VALIDATION_ERROR','Confirm the cascade preview and provide a reason','confirmation'); end if;
   update public.outreach_events set state='cancelled' where user_id=owner and state='queued' and (scheduled_for is null or scheduled_for>now()) and (job_id in (select j.id from public.jobs j where j.user_id=owner and company_id=id) or contact_id in (select ct.id from public.contacts ct where ct.user_id=owner and company_id=id));
   update public.jobs set stage='archived' where user_id=owner and company_id=id and stage<>'archived';
   update public.contacts set archived_at=now() where user_id=owner and company_id=id and archived_at is null;
   r=crm_private.save('companies',owner,jsonb_build_object('archived_at',now()),id,expected);
   result=jsonb_build_object('company',r,'affected',jsonb_build_object('jobs',count_jobs,'contacts',count_contacts,'outreach',count_outreach));
  end if;
 elsif op='companies.health' then
  perform crm_private.required(input,array['id']); perform crm_private.record('companies',owner,id);
  result=jsonb_build_object('active_jobs',(select count(*) from public.jobs where user_id=owner and company_id=id and stage not in ('rejected','archived')),'last_outreach',(select max(occurred_at) from public.outreach_events where user_id=owner and (contact_id in (select ct.id from public.contacts ct where ct.user_id=owner and company_id=id) or job_id in (select j.id from public.jobs j where j.user_id=owner and company_id=id))),'sent',(select count(*) from public.outreach_events where user_id=owner and state='sent' and (contact_id in (select ct.id from public.contacts ct where ct.user_id=owner and company_id=id) or job_id in (select j.id from public.jobs j where j.user_id=owner and company_id=id))),'responded',(select count(*) from public.outreach_events where user_id=owner and state='responded' and (contact_id in (select ct.id from public.contacts ct where ct.user_id=owner and company_id=id) or job_id in (select j.id from public.jobs j where j.user_id=owner and company_id=id))));
 elsif op='outreach.draft' then
  perform crm_private.required(input,array['body','channel','kind']);
  result=crm_private.save('outreach_events',owner,(input-'idempotency_key')||jsonb_build_object('state','draft'));
 elsif op in ('outreach.queue','outreach.mark_sent') then
  perform crm_private.required(input,array['id','expected_version']); r=crm_private.record('outreach_events',owner,id,expected);
  if op='outreach.queue' then
   perform crm_private.required(input,array['scheduled_for']);
   if r->>'state'<>'draft' then perform crm_private.fail('CONFLICT','Only draft outreach can be queued','state',(r->>'version')::bigint); end if;
   if (input->>'scheduled_for')::timestamptz<now() then perform crm_private.fail('VALIDATION_ERROR','Schedule must be in the future','scheduled_for'); end if;
   result=crm_private.save('outreach_events',owner,jsonb_build_object('state','queued','scheduled_for',input->'scheduled_for'),id,expected);
  else
   perform crm_private.required(input,array['occurred_at','confirmation_ref']);
   if r->>'state' not in ('draft','queued') then perform crm_private.fail('CONFLICT','Outreach is already settled','state',(r->>'version')::bigint); end if;
   result=crm_private.save('outreach_events',owner,jsonb_build_object('state','sent','occurred_at',input->'occurred_at','external_ref',input->'confirmation_ref'),id,expected);
   if r->>'kind'='application' and r->>'job_id' is not null then
    target=crm_private.record('jobs',owner,(r->>'job_id')::uuid);
    perform crm_private.save('jobs',owner,jsonb_build_object('applied_at',coalesce(target->>'applied_at',input->>'occurred_at'),'applied_date_precision',coalesce(target->>'applied_date_precision','instant'),'stage',case when target->>'stage' in ('radar','review','ready') then 'applied' else target->>'stage' end),(target->>'id')::uuid,(target->>'version')::bigint);
   end if;
   if r->>'contact_id' is not null then
    c=crm_private.record('contacts',owner,(r->>'contact_id')::uuid);
    c=crm_private.save('contacts',owner,jsonb_build_object('last_interacted_at',input->'occurred_at')||case when r->>'kind'='invitation' and c->>'status'='uncontacted' then jsonb_build_object('status','invited','invite_at',input->'occurred_at') when r->>'kind' in ('message','followup') and c->>'status' in ('uncontacted','invited','connected','no_response') then jsonb_build_object('status','messaged') else '{}'::jsonb end,(c->>'id')::uuid,(c->>'version')::bigint);
    perform crm_private.advance_contact(owner,c);
   end if;
  end if;
 elsif op='outreach.record_response' then
  perform crm_private.required(input,array['contact_id','body','occurred_at']); c=crm_private.record('contacts',owner,(input->>'contact_id')::uuid);
  if input->>'job_id' is not null and c->>'job_id' is distinct from input->>'job_id' then perform crm_private.fail('VALIDATION_ERROR','Response job must match contact association','job_id'); end if;
  r=crm_private.save('outreach_events',owner,jsonb_build_object('contact_id',input->'contact_id','job_id',coalesce(input->'job_id',c->'job_id'),'body',input->'body','occurred_at',input->'occurred_at','channel','manual','kind','response','state','responded'));
  c=crm_private.save('contacts',owner,jsonb_build_object('status','replied','last_interacted_at',input->'occurred_at'),(c->>'id')::uuid,(c->>'version')::bigint);
  changed=crm_private.advance_contact(owner,c); result=jsonb_build_object('event',r,'contact',c,'changed_jobs',changed);
 elsif op='verifications.record' then
  perform crm_private.required(input,array['status','checked_at','notes']); result=crm_private.save('verifications',owner,input-'idempotency_key');
 elsif op='resumes.finalize' then
  perform crm_private.required(input,array['label','storage_path','checksum','media_type']);
  if split_part(input->>'storage_path','/',1)<>owner::text then perform crm_private.fail('FORBIDDEN','Resume path must belong to owner','storage_path'); end if;
  if not exists(select 1 from storage.objects where bucket_id='resumes' and name=input->>'storage_path') then perform crm_private.fail('NOT_FOUND','Upload the file before finalizing','storage_path'); end if;
  result=crm_private.save('resumes',owner,input-'idempotency_key');
  if coalesce((input->>'active')::boolean,true) then update public.resumes set active=false where user_id=owner and public.resumes.id<>(result->>'id')::uuid and active and country is not distinct from result->>'country' and track is not distinct from result->>'track'; end if;
  result=result-'storage_path';
 elsif op='resumes.get_download' then
  perform crm_private.required(input,array['id']); r=crm_private.record('resumes',owner,id); result=jsonb_build_object('storage_path',r->'storage_path','expires_in',300);
 elsif op='tasks.submit' then
  perform crm_private.required(input,array['kind','payload']);
  if input->>'kind' not in ('bulk_import','embed_records') then perform crm_private.fail('VALIDATION_ERROR','Invalid task kind','kind'); end if;
  if jsonb_typeof(input->'payload')<>'object' or jsonb_typeof(input->'payload'->'records') is distinct from 'array' then perform crm_private.fail('VALIDATION_ERROR','Payload requires records array','payload'); end if;
  if jsonb_array_length(input->'payload'->'records') not between 1 and 50 then perform crm_private.fail('VALIDATION_ERROR','Batch must contain 1..50 records','payload.records'); end if;
  if input->>'kind'='bulk_import' then
   perform crm_private.validate(input->'payload',array['import_namespace','records']); perform crm_private.required(input->'payload',array['import_namespace']);
   for item in select value from jsonb_array_elements(input->'payload'->'records') loop
    perform crm_private.validate(item,array['entity_type','legacy_id','data']);
    perform crm_private.required(item,array['entity_type','legacy_id','data']);
    if item->>'entity_type' not in ('companies','sources','jobs','contacts','outreach_events','interviews','resumes','verifications') then perform crm_private.fail('VALIDATION_ERROR','Invalid import entity','entity_type'); end if;
    perform crm_private.validate(item->'data',crm_private.editable(item->>'entity_type')||array['id']);
    perform crm_private.required(item->'data',array['id']);
    perform crm_private.validate_entity(item->>'entity_type',(item->'data')-'id',true);
   end loop;
  else
   perform crm_private.validate(input->'payload',array['records']);
   for item in select value from jsonb_array_elements(input->'payload'->'records') loop
    perform crm_private.validate(item,array['entity_type','id']); perform crm_private.required(item,array['entity_type','id']);
    if item->>'entity_type' not in ('companies','jobs','contacts') then perform crm_private.fail('VALIDATION_ERROR','Invalid embedding entity','entity_type'); end if;
    perform crm_private.record(item->>'entity_type',owner,(item->>'id')::uuid);
   end loop;
  end if;
  insert into public.crm_jobs(user_id,kind,payload,request_id) values(owner,input->>'kind',input->'payload',key) returning to_jsonb(public.crm_jobs.*) into r;
  result=jsonb_build_object('task_id',r->'id','state',r->'state','version',r->'version');
 elsif op in ('tasks.get','tasks.cancel') then
  perform crm_private.required(input,array['task_id']); r=crm_private.record('crm_jobs',owner,(input->>'task_id')::uuid,expected);
  if op='tasks.cancel' then
   perform crm_private.required(input,array['expected_version']);
   if r->>'state'<>'queued' then perform crm_private.fail('CONFLICT','Only queued tasks can be cancelled','state',(r->>'version')::bigint); end if;
   update public.crm_jobs set state='cancelled' where user_id=owner and public.crm_jobs.id=(input->>'task_id')::uuid returning to_jsonb(public.crm_jobs.*) into r;
  end if;
  result=r-array['payload','lease_token','lease_until','request_id','user_id'];
 elsif op='push.subscribe' then
  perform crm_private.required(input,array['endpoint','p256dh','auth']);
  -- Allow known push vendors only. Never let a subscription become a worker SSRF request.
  if input->>'endpoint' !~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com|web\.push\.apple\.com)/[^[:space:]]+$' then perform crm_private.fail('VALIDATION_ERROR','Unsupported push endpoint','endpoint'); end if;
  if input->>'p256dh' !~ '^[A-Za-z0-9_-]{87}=?$' or input->>'auth' !~ '^[A-Za-z0-9_-]{22}==?$' and input->>'auth' !~ '^[A-Za-z0-9_-]{22}$' then perform crm_private.fail('VALIDATION_ERROR','Malformed push keys','p256dh'); end if;
  insert into public.push_subscriptions(user_id,endpoint,p256dh,auth,device_label) values(owner,input->>'endpoint',input->>'p256dh',input->>'auth',input->>'device_label') on conflict(user_id,endpoint) do update set active=true,p256dh=excluded.p256dh,auth=excluded.auth,device_label=excluded.device_label returning jsonb_build_object('id',public.push_subscriptions.id,'active',active,'version',version) into result;
 elsif op='push.deactivate' then
  update public.push_subscriptions set active=false where user_id=owner and (input->>'endpoint' is null or endpoint=input->>'endpoint') and (input->>'id' is null or public.push_subscriptions.id=(input->>'id')::uuid); result=jsonb_build_object('active',false);
 elsif op='dashboard.summary' then
  if input ? 'from' and input ? 'to' and (input->>'from')::timestamptz>(input->>'to')::timestamptz then perform crm_private.fail('VALIDATION_ERROR','from must precede to','from'); end if;
  result=jsonb_build_object('counts_by_stage',(select coalesce(jsonb_object_agg(stage,n),'{}') from (select stage,count(*) n from public.jobs where user_id=owner group by stage) s),'unknown_application_dates',(select count(*) from public.jobs where user_id=owner and applied_at is null and stage in ('applied','invited','messaged','replied','interview','offer','rejected')),'dated_applications',(select count(*) from public.jobs where user_id=owner and applied_at is not null and (input->>'from' is null or applied_at>=(input->>'from')::timestamptz) and (input->>'to' is null or applied_at<=(input->>'to')::timestamptz)),'funnel',(select coalesce(jsonb_object_agg(stage,n),'{}') from (select after->>'stage' stage,count(distinct entity_id) n from public.audit_events where user_id=owner and entity_type='jobs' and action not like 'import.%' and after->>'applied_at' is not null and after->>'stage' is distinct from before->>'stage' and (input->>'from' is null or created_at>=(input->>'from')::timestamptz) and (input->>'to' is null or created_at<=(input->>'to')::timestamptz) group by after->>'stage') s));
 elsif op='search.semantic' then
  perform crm_private.required(input,array['entity_type','embedding','model']);
  if jsonb_typeof(input->'embedding')='array' then
   if exists(select 1 from jsonb_array_elements(input->'embedding') e where jsonb_typeof(e)<>'number') or (select coalesce(sum((e::text::float8)^2),0) from jsonb_array_elements(input->'embedding') e)=0 then perform crm_private.fail('VALIDATION_ERROR','Embedding must be a nonzero numeric vector','embedding'); end if;
  end if;
  if input->>'entity_type' not in ('jobs','contacts','companies') or jsonb_typeof(input->'embedding') is distinct from 'array' or jsonb_array_length(input->'embedding') not between 1 and 4096 then perform crm_private.fail('VALIDATION_ERROR','Supply entity_type and embedding vector','embedding'); end if;
  if coalesce((input->>'limit')::int,20) not between 1 and 50 then perform crm_private.fail('VALIDATION_ERROR','Limit must be 1..50','limit'); end if;
  execute format('select coalesce(jsonb_agg(r),''[]''::jsonb) from (select jsonb_build_object(''record'',to_jsonb(t),''score'',v.score,''verification'',(select to_jsonb(vf) from public.verifications vf where vf.user_id=$1 and %s order by checked_at desc,id desc limit 1)) r from public.%I t join crm_private.embeddings e on e.user_id=t.user_id and e.entity_id=t.id and e.entity_type=$2 and e.source_version=t.version cross join lateral (select case when sum(a*a)=0 or sum(b*b)=0 then null else greatest(-1.0,least(1.0,sum(a*b)/(sqrt(sum(a*a))*sqrt(sum(b*b))))) end score from unnest(e.vector,array(select value::text::float8 from jsonb_array_elements($3))) z(a,b)) v where t.user_id=$1 and v.score is not null and e.model=$5 and cardinality(e.vector)=jsonb_array_length($3) order by v.score desc nulls last,t.id limit $4) s',case input->>'entity_type' when 'jobs' then 'vf.job_id=t.id' when 'companies' then 'vf.company_id=t.id' else 'false' end,input->>'entity_type') into r using owner,input->>'entity_type',input->'embedding',coalesce((input->>'limit')::int,20),input->>'model';
  result=jsonb_build_object('items',r,'has_more',false,'next_cursor',null);
 end if;
 if mut then insert into public.mutation_receipts(user_id,idempotency_key,operation,payload_hash,response) values(owner,key,op,hash,result); end if;
 return result;
exception
 when sqlstate 'CR001' then return jsonb_build_object('error',SQLERRM::jsonb);
 when foreign_key_violation then return jsonb_build_object('error',jsonb_build_object('code','VALIDATION_ERROR','message','Reference must exist and belong to this owner','field','reference','retryable',false));
 when unique_violation then return jsonb_build_object('error',jsonb_build_object('code','CONFLICT','message','Identity already exists','retryable',false));
 when check_violation or not_null_violation or invalid_text_representation or datetime_field_overflow or invalid_parameter_value then
  get stacked diagnostics error_field=COLUMN_NAME;
  return jsonb_build_object('error',jsonb_strip_nulls(jsonb_build_object('code','VALIDATION_ERROR','message','Invalid field value','field',nullif(error_field,''),'retryable',false)));
 when others then return jsonb_build_object('error',jsonb_build_object('code','TEMPORARY_FAILURE','message','Operation failed; no changes were committed','retryable',true));
end $$;

-- Definer privilege is necessary because direct user writes are revoked. Internal implementation is private.
create function public.crm_operation(p_operation text,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then return jsonb_build_object('error',jsonb_build_object('code','UNAUTHENTICATED','message','Sign in to continue','retryable',false)); end if;
 if not crm_private.is_owner() and exists(select 1 from crm_private.settings where owner_id=auth.uid()) then return jsonb_build_object('error',jsonb_build_object('code','UNAUTHENTICATED','message','Session was revoked','retryable',false)); end if;
 return crm_private.operation(auth.uid(),p_operation,p_input);
exception when invalid_text_representation then return jsonb_build_object('error',jsonb_build_object('code','UNAUTHENTICATED','message','Invalid session','retryable',false));
end $$;
revoke all on all functions in schema crm_private from public,anon,authenticated;
grant execute on function crm_private.is_owner() to authenticated;
revoke all on function public.crm_operation(text,jsonb) from public,anon,authenticated;
grant execute on function public.crm_operation(text,jsonb) to authenticated;
