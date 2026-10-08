-- Owner-only transactional email; previous migrations remain frozen.
create table public.email_preferences (
 id uuid primary key default gen_random_uuid(), user_id uuid not null unique references auth.users(id),
 enabled boolean not null default false, version bigint not null default 1 check(version>0),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.email_preferences enable row level security;
create policy owner_read on public.email_preferences for select to authenticated using(user_id=(select auth.uid()) and (select crm_private.is_owner()));
revoke all on public.email_preferences from public,anon,authenticated,crm_worker;
grant select on public.email_preferences to authenticated;
create trigger guard_record before insert or update on public.email_preferences for each row execute function crm_private.guard_record();
create trigger audit_record after insert or update on public.email_preferences for each row execute function crm_private.audit_record();

create function public.crm_email_preferences(p_input jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid=auth.uid(); pref public.email_preferences; receipt public.mutation_receipts; key uuid; hash text; result jsonb;
begin
 if owner is null then perform crm_private.fail('UNAUTHENTICATED','Sign in to continue'); end if;
 if not crm_private.is_owner() then perform crm_private.fail('FORBIDDEN','Authorized owner session required'); end if;
 -- Initial absent preference has version 0; other CRM entities start at 1.
 perform crm_private.validate(p_input-array['enabled','expected_version'],array['idempotency_key']);
 if p_input='{}'::jsonb then
  select * into pref from public.email_preferences where user_id=owner;
  return jsonb_build_object('enabled',coalesce(pref.enabled,false),'version',coalesce(pref.version,0));
 end if;
 perform crm_private.required(p_input,array['enabled','expected_version','idempotency_key']);
 if jsonb_typeof(p_input->'enabled')<>'boolean' or jsonb_typeof(p_input->'expected_version')<>'number' or (p_input->>'expected_version')!~'^[0-9]+$' then perform crm_private.fail('VALIDATION_ERROR','Expected boolean and nonnegative integer version'); end if;
 key=(p_input->>'idempotency_key')::uuid;
 hash=encode(extensions.digest('email.preferences'||p_input::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(owner::text,0));
 select * into receipt from public.mutation_receipts where user_id=owner and idempotency_key=key;
 if found then
  if receipt.operation<>'email.preferences' or receipt.payload_hash<>hash then perform crm_private.fail('IDEMPOTENCY_CONFLICT','Idempotency key was used for different input','idempotency_key'); end if;
  return receipt.response;
 end if;
 select * into pref from public.email_preferences where user_id=owner for update;
 if coalesce(pref.version,0)<>(p_input->>'expected_version')::bigint then perform crm_private.fail('CONFLICT','Preference changed','expected_version',coalesce(pref.version,0)); end if;
 perform set_config('crm.operation','email.preferences',true);perform set_config('crm.request_id',key::text,true);perform set_config('crm.actor_kind','user',true);
 if pref.id is null then insert into public.email_preferences(user_id,enabled) values(owner,(p_input->>'enabled')::boolean) returning * into pref;
 else update public.email_preferences set enabled=(p_input->>'enabled')::boolean where user_id=owner returning * into pref; end if;
 if not pref.enabled then update crm_private.email_deliveries set state='cancelled',lease_token=null,lease_until=null where user_id=owner and state='queued'; end if;
 result=jsonb_build_object('enabled',pref.enabled,'version',pref.version);
 insert into public.mutation_receipts(user_id,idempotency_key,operation,payload_hash,response) values(owner,key,'email.preferences',hash,result);
 return result;
exception when sqlstate 'CR001' then return jsonb_build_object('error',SQLERRM::jsonb);
 when invalid_text_representation or numeric_value_out_of_range then return jsonb_build_object('error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid preference input','retryable',false));
 when others then return jsonb_build_object('error',jsonb_build_object('code','TEMPORARY_FAILURE','message','Preference update failed; no changes committed','retryable',true));
end $$;
revoke all on function public.crm_email_preferences(jsonb) from public,anon,authenticated;
grant execute on function public.crm_email_preferences(jsonb) to authenticated;

create table crm_private.email_deliveries (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),crm_job_id uuid not null,
 recipient text not null,created_at timestamptz not null default now(),
 state text not null default 'queued' check(state in ('queued','accepted','failed','cancelled')),
 attempts integer not null default 0 check(attempts between 0 and 3),next_attempt_at timestamptz not null default now(),
 first_attempt_at timestamptz,lease_until timestamptz,lease_token uuid,provider_email_id uuid,
 unique(user_id,crm_job_id),foreign key(user_id,crm_job_id) references public.crm_jobs(user_id,id)
);
alter table crm_private.email_deliveries enable row level security;
revoke all on crm_private.email_deliveries from public,anon,authenticated,crm_worker;
create index email_deliveries_claim on crm_private.email_deliveries(next_attempt_at,id) where state='queued';

create function crm_private.enqueue_task_email() returns trigger language plpgsql security definer set search_path='' as $$
declare opted boolean;recipient text;
begin
 if new.state not in ('completed','failed') or old.state in ('completed','failed','cancelled') then return new;end if;
 if not exists(select 1 from crm_private.settings where owner_id=new.user_id) then return new;end if;
 select enabled into opted from public.email_preferences where user_id=new.user_id for share;
 if opted is distinct from true then return new;end if;
 select email into recipient from auth.users where id=new.user_id;
 if recipient is null or recipient='' then perform crm_private.fail('VALIDATION_ERROR','Owner email is required for notifications');end if;
 insert into crm_private.email_deliveries(user_id,crm_job_id,recipient) values(new.user_id,new.id,recipient) on conflict(user_id,crm_job_id) do nothing;
 return new;
end $$;
create trigger enqueue_task_email after update of state on public.crm_jobs for each row execute function crm_private.enqueue_task_email();

create function crm_private.email_claim() returns jsonb language plpgsql security definer set search_path='' as $$
declare d crm_private.email_deliveries;
begin
 update crm_private.email_deliveries set state='cancelled',lease_until=null,lease_token=null where user_id=(select owner_id from crm_private.settings) and state='queued' and not exists(select 1 from public.email_preferences p where p.user_id=email_deliveries.user_id and p.enabled);
 -- Never retry an ambiguous provider operation beyond its retained idempotency window.
 update crm_private.email_deliveries set state='failed',lease_until=null,lease_token=null where user_id=(select owner_id from crm_private.settings) and state='queued' and (attempts>=3 or first_attempt_at<=now()-interval '23 hours') and (lease_until is null or lease_until<now());
 select * into d from crm_private.email_deliveries where user_id=(select owner_id from crm_private.settings) and state='queued' and attempts<3 and next_attempt_at<=now() and (lease_until is null or lease_until<now()) order by next_attempt_at,id for update skip locked limit 1;
 if not found then return null;end if;
 update crm_private.email_deliveries set attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,now()),lease_until=now()+interval '60 seconds',lease_token=gen_random_uuid() where id=d.id returning * into d;
 return jsonb_build_object('id',d.id,'task_id',d.crm_job_id,'recipient',d.recipient,'lease_token',d.lease_token);
end $$;
create function crm_private.email_authorize(delivery uuid,token uuid) returns boolean language sql security definer set search_path='' as $$
 select exists(select 1 from crm_private.email_deliveries d join public.email_preferences p on p.user_id=d.user_id and p.enabled where d.user_id=(select owner_id from crm_private.settings) and d.id=delivery and d.state='queued' and d.lease_token=token and d.lease_until>now() and d.first_attempt_at>now()-interval '23 hours');
$$;
create function crm_private.email_finish(delivery uuid,token uuid,status integer,provider_id uuid default null) returns void language plpgsql security definer set search_path='' as $$
declare d crm_private.email_deliveries;next_state text;
begin
 select * into d from crm_private.email_deliveries where id=delivery for update;
 if not found or d.user_id<>(select owner_id from crm_private.settings) or d.state<>'queued' or d.lease_token is distinct from token or d.lease_until<=now() then perform crm_private.fail('FORBIDDEN','Valid email lease required');end if;
 if status between 200 and 299 and provider_id is null then perform crm_private.fail('VALIDATION_ERROR','Provider acceptance ID required');end if;
 next_state=case when status between 200 and 299 then 'accepted' when status=-1 then 'cancelled' when (status=0 or status=429 or status>=500) and d.attempts<3 and d.first_attempt_at>now()-interval '23 hours' then 'queued' else 'failed' end;
 update crm_private.email_deliveries set state=next_state,provider_email_id=case when next_state='accepted' then provider_id else null end,lease_until=null,lease_token=null,next_attempt_at=now()+make_interval(secs=>case when attempts=1 then 5 else 30 end) where id=d.id;
 insert into public.audit_events(user_id,entity_type,entity_id,action,actor_subject,actor_kind,request_id,before,after)
 values(d.user_id,'email_deliveries',d.id,'email.'||next_state,'crm_worker','worker',d.id,null,jsonb_build_object('state',next_state,'attempts',d.attempts));
end $$;
revoke all on function crm_private.enqueue_task_email(),crm_private.email_claim(),crm_private.email_authorize(uuid,uuid),crm_private.email_finish(uuid,uuid,integer,uuid) from public,anon,authenticated;
grant execute on function crm_private.email_claim(),crm_private.email_authorize(uuid,uuid),crm_private.email_finish(uuid,uuid,integer,uuid) to crm_worker;
