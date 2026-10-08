-- Add truthful date filters and scoped descending keyset order; existing migrations stay frozen.
-- Filters apply to the owner-scoped query before its cursor/limit; legacy text is never parsed.
create or replace function crm_private.jobs_page(owner uuid,input jsonb) returns jsonb language plpgsql set search_path='' as $$
declare filters jsonb; fingerprint text; cur jsonb; size integer; rows jsonb; items jsonb; last_row jsonb; predicate text=''; k text; query text; location_pattern text; sort_order text; row_order text; cursor_predicate text;
begin
 if owner is null or owner is distinct from auth.uid() or not crm_private.is_owner() then perform crm_private.fail('FORBIDDEN','Owner session required'); end if;
 if input is null or jsonb_typeof(input)<>'object' or octet_length(input::text)>1048576 then perform crm_private.fail('VALIDATION_ERROR','Expected object of at most 1 MiB'); end if;
 perform crm_private.validate(input-array['location_query','salary_known','sort','added_from','added_before','posted_from','posted_to'],array['stage','company_id','query','cursor','limit','salary_min','salary_max','currency']);
 foreach k in array array['company_id','location_query','salary_known','salary_min','salary_max','currency'] loop
  if input ? k and input->k='null'::jsonb then perform crm_private.fail('VALIDATION_ERROR','Filter cannot be null',k); end if;
 end loop;
 if input ? 'location_query' and (jsonb_typeof(input->'location_query')<>'string' or length(input->>'location_query')>500) then perform crm_private.fail('VALIDATION_ERROR','Expected location text of at most 500 characters','location_query'); end if;
 if input ? 'salary_known' and jsonb_typeof(input->'salary_known')<>'boolean' then perform crm_private.fail('VALIDATION_ERROR','Expected boolean','salary_known'); end if;
 foreach k in array array['sort','added_from','added_before','posted_from','posted_to'] loop
  if input ? k and jsonb_typeof(input->k) is distinct from 'string' then perform crm_private.fail('VALIDATION_ERROR','Expected non-null text',k); end if;
 end loop;
 if input ? 'sort' and input->>'sort' not in ('created_desc','posted_desc') then perform crm_private.fail('VALIDATION_ERROR','Unsupported sort','sort'); end if;
 foreach k in array array['added_from','added_before','posted_from','posted_to'] loop
  if not input ? k then continue; end if;
  begin
   if k in ('added_from','added_before') then
    if (input->>k) !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' then raise invalid_datetime_format; end if;
    perform (input->>k)::timestamptz;
   else
    if (input->>k) !~ '^\d{4}-\d{2}-\d{2}$' then raise invalid_datetime_format; end if;
    perform (input->>k)::date;
   end if;
  exception when invalid_datetime_format or datetime_field_overflow or invalid_time_zone_displacement_value then perform crm_private.fail('VALIDATION_ERROR','Invalid date boundary',k); end;
 end loop;
 if input ? 'added_from' and input ? 'added_before' and (input->>'added_from')::timestamptz >= (input->>'added_before')::timestamptz then perform crm_private.fail('VALIDATION_ERROR','Invalid added interval','added_before'); end if;
 if input ? 'posted_from' and input ? 'posted_to' and (input->>'posted_from')::date > (input->>'posted_to')::date then perform crm_private.fail('VALIDATION_ERROR','Invalid publication interval','posted_to'); end if;
 sort_order=case input->>'sort' when 'created_desc' then 't.created_at desc,t.id desc' when 'posted_desc' then 't.posted_on desc nulls last,t.id desc' else 't.created_at,t.id' end;
 row_order=case input->>'sort' when 'created_desc' then 'r->>''created_at'' desc,r->>''id'' desc' when 'posted_desc' then 'r->>''posted_on'' desc nulls last,r->>''id'' desc' else 'r->>''created_at'',r->>''id''' end;
 cursor_predicate=case input->>'sort'
  when 'created_desc' then '(t.created_at,t.id)<(($2->>''created_at'')::timestamptz,($2->>''id'')::uuid)'
  when 'posted_desc' then '((($2->>''posted_on'') is null and t.posted_on is null and t.id<($2->>''id'')::uuid) or (($2->>''posted_on'') is not null and (t.posted_on is null or (t.posted_on,t.id)<(($2->>''posted_on'')::date,($2->>''id'')::uuid))))'
  else '(t.created_at,t.id)>(($2->>''created_at'')::timestamptz,($2->>''id'')::uuid)' end;
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
  if input->>'sort'='posted_desc' then
   if not cur ? 'posted_on' or (cur->'posted_on'<>'null'::jsonb and (jsonb_typeof(cur->'posted_on') is distinct from 'string' or (cur->>'posted_on') !~ '^\d{4}-\d{2}-\d{2}$')) then perform crm_private.fail('VALIDATION_ERROR','Invalid publication cursor','cursor'); end if;
   begin perform (cur->>'posted_on')::date; exception when invalid_datetime_format or datetime_field_overflow then perform crm_private.fail('VALIDATION_ERROR','Invalid publication cursor','cursor'); end;
  end if;
 end if;
 for k in select jsonb_object_keys(filters) loop
  if k='sort' then continue;
  elsif k='added_from' then predicate=predicate||format(' and t.created_at >= %L::timestamptz',input->>k);
  elsif k='added_before' then predicate=predicate||format(' and t.created_at < %L::timestamptz',input->>k);
  elsif k='posted_from' then predicate=predicate||format(' and t.posted_on >= %L::date',input->>k);
  elsif k='posted_to' then predicate=predicate||format(' and t.posted_on <= %L::date',input->>k);
  elsif k='query' then
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
 execute format('select coalesce(jsonb_agg(r order by %s),''[]''::jsonb) from (select to_jsonb(t)||jsonb_build_object(''verification'',(select to_jsonb(vf) from public.verifications vf where vf.user_id=t.user_id and vf.job_id=t.id order by checked_at desc,id desc limit 1)) r from public.jobs t where t.user_id=$1%s and ($2 is null or %s) order by %s limit $3) s',row_order,predicate,cursor_predicate,sort_order) into rows using owner,cur,size+1;
 select coalesce(jsonb_agg(value order by ordinality),'[]') into items from jsonb_array_elements(rows) with ordinality where ordinality<=size;
 last_row=items->(jsonb_array_length(items)-1);
 return jsonb_build_object('items',items,'has_more',jsonb_array_length(rows)>size,'next_cursor',case when jsonb_array_length(rows)>size then encode(convert_to(jsonb_build_object('scope',fingerprint,'created_at',last_row->>'created_at','posted_on',last_row->>'posted_on','id',last_row->>'id')::text,'UTF8'),'base64') else null end);
end $$;
revoke all on function crm_private.jobs_page(uuid,jsonb) from public,anon,authenticated;

