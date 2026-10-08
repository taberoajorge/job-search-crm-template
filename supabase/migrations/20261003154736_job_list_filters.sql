-- Filters apply to the owner-scoped query before its cursor/limit; legacy text is never parsed.
create function crm_private.jobs_page(owner uuid,input jsonb) returns jsonb language plpgsql set search_path='' as $$
declare filters jsonb; fingerprint text; cur jsonb; size integer; rows jsonb; items jsonb; last_row jsonb; predicate text=''; k text; query text; location_pattern text;
begin
 if owner is null or owner is distinct from auth.uid() or not crm_private.is_owner() then perform crm_private.fail('FORBIDDEN','Owner session required'); end if;
 if input is null or jsonb_typeof(input)<>'object' or octet_length(input::text)>1048576 then perform crm_private.fail('VALIDATION_ERROR','Expected object of at most 1 MiB'); end if;
 perform crm_private.validate(input-array['location_query','salary_known'],array['stage','company_id','query','cursor','limit','salary_min','salary_max','currency']);
 foreach k in array array['company_id','location_query','salary_known','salary_min','salary_max','currency'] loop
  if input ? k and input->k='null'::jsonb then perform crm_private.fail('VALIDATION_ERROR','Filter cannot be null',k); end if;
 end loop;
 if input ? 'location_query' and (jsonb_typeof(input->'location_query')<>'string' or length(input->>'location_query')>500) then perform crm_private.fail('VALIDATION_ERROR','Expected location text of at most 500 characters','location_query'); end if;
 if input ? 'salary_known' and jsonb_typeof(input->'salary_known')<>'boolean' then perform crm_private.fail('VALIDATION_ERROR','Expected boolean','salary_known'); end if;
 if length(input->>'cursor')>2048 then perform crm_private.fail('VALIDATION_ERROR','Cursor exceeds 2048 characters','cursor'); end if;
 if input ? 'salary_min' or input ? 'salary_max' then
  if not input ? 'currency' then perform crm_private.fail('VALIDATION_ERROR','Numeric salary filtering requires currency','currency'); end if;
  if input->'salary_known'='false'::jsonb then perform crm_private.fail('VALIDATION_ERROR','Unknown salary cannot be combined with numeric bounds','salary_known'); end if;
  if input ? 'salary_min' and input ? 'salary_max' and (input->>'salary_min')::numeric>(input->>'salary_max')::numeric then perform crm_private.fail('VALIDATION_ERROR','Maximum must not be below minimum','salary_max'); end if;
  predicate=predicate||' and (t.salary_min is not null or t.salary_max is not null)';
 end if;
 if input ? 'limit' and (input->>'limit')::numeric not between 1 and 50 then perform crm_private.fail('VALIDATION_ERROR','Limit must be 1..50','limit'); end if;
 size=coalesce((input->>'limit')::integer,20);
 filters=input-array['cursor','limit']; fingerprint=md5(owner::text||'jobs'||filters::text);
 if input->>'cursor' is not null then
  begin cur=convert_from(decode(input->>'cursor','base64'),'UTF8')::jsonb; exception when others then perform crm_private.fail('VALIDATION_ERROR','Invalid cursor','cursor'); end;
  if jsonb_typeof(cur)<>'object' or jsonb_typeof(cur->'scope') is distinct from 'string' or jsonb_typeof(cur->'created_at') is distinct from 'string' or jsonb_typeof(cur->'id') is distinct from 'string' then perform crm_private.fail('VALIDATION_ERROR','Invalid cursor fields','cursor'); end if;
  if cur->>'scope' is distinct from fingerprint then perform crm_private.fail('VALIDATION_ERROR','Cursor does not match owner/filter','cursor'); end if;
  if (cur->>'created_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' or (cur->>'id') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then perform crm_private.fail('VALIDATION_ERROR','Invalid cursor position','cursor'); end if;
  begin
   perform (cur->>'created_at')::timestamptz,(cur->>'id')::uuid;
  exception when invalid_datetime_format or datetime_field_overflow or invalid_time_zone_displacement_value or invalid_text_representation then perform crm_private.fail('VALIDATION_ERROR','Invalid cursor position','cursor'); end;
 end if;
 for k in select jsonb_object_keys(filters) loop
  if k='query' then
   query=input->>'query';
   predicate=predicate||format(' and (to_tsvector(''simple'',t.title||'' ''||coalesce(t.description_summary,'''')||'' ''||t.notes||'' ''||coalesce((select co.name from public.companies co where co.user_id=t.user_id and co.id=t.company_id),'''')) @@ plainto_tsquery(''simple'',%L) or t.title ilike %L or extensions.similarity(t.title,%L)>0.25)',query,'%'||query||'%',query);
  elsif k='location_query' then
   location_pattern='%'||replace(replace(replace(input->>k,chr(92),chr(92)||chr(92)),'%',chr(92)||'%'),'_',chr(92)||'_')||'%';
   predicate=predicate||format(' and t.location ilike %L escape %L',location_pattern,chr(92));
  elsif k='salary_known' then
   predicate=predicate||case when (input->>k)::boolean then ' and (t.salary_min is not null or t.salary_max is not null)' else ' and t.salary_min is null and t.salary_max is null' end;
  elsif k='salary_min' then
   predicate=predicate||format(' and (t.salary_max is null or t.salary_max >= %L::numeric)',input->>k);
  elsif k='salary_max' then
   predicate=predicate||format(' and (t.salary_min is null or t.salary_min <= %L::numeric)',input->>k);
  else predicate=predicate||format(' and to_jsonb(t)->>%L = %L',k,input->>k);
  end if;
 end loop;
 execute format('select coalesce(jsonb_agg(r order by r->>''created_at'',r->>''id''),''[]''::jsonb) from (select to_jsonb(t)||jsonb_build_object(''verification'',(select to_jsonb(vf) from public.verifications vf where vf.user_id=t.user_id and vf.job_id=t.id order by checked_at desc,id desc limit 1)) r from public.jobs t where user_id=$1%s and ($2 is null or (created_at,id)>(($2->>''created_at'')::timestamptz,($2->>''id'')::uuid)) order by created_at,id limit $3) s',predicate) into rows using owner,cur,size+1;
 select coalesce(jsonb_agg(value order by ordinality),'[]') into items from jsonb_array_elements(rows) with ordinality where ordinality<=size;
 last_row=items->(jsonb_array_length(items)-1);
 return jsonb_build_object('items',items,'has_more',jsonb_array_length(rows)>size,'next_cursor',case when jsonb_array_length(rows)>size then encode(convert_to(jsonb_build_object('scope',fingerprint,'created_at',last_row->>'created_at','id',last_row->>'id')::text,'UTF8'),'base64') else null end);
end $$;
revoke all on function crm_private.jobs_page(uuid,jsonb) from public,anon,authenticated;

-- Retain the live session/owner boundary and dispatch every other operation unchanged.
create or replace function public.crm_operation(p_operation text,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then return jsonb_build_object('error',jsonb_build_object('code','UNAUTHENTICATED','message','Sign in to continue','retryable',false)); end if;
 if not crm_private.is_owner() and exists(select 1 from crm_private.settings where owner_id=auth.uid()) then return jsonb_build_object('error',jsonb_build_object('code','UNAUTHENTICATED','message','Session was revoked','retryable',false)); end if;
 if p_operation='jobs.list' then return crm_private.jobs_page(auth.uid(),p_input); end if;
 return crm_private.operation(auth.uid(),p_operation,p_input);
exception
 when sqlstate 'CR001' then return jsonb_build_object('error',SQLERRM::jsonb);
 when invalid_text_representation then return jsonb_build_object('error',jsonb_build_object('code','UNAUTHENTICATED','message','Invalid session','retryable',false));
end $$;
