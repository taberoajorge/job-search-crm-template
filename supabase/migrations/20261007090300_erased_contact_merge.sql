-- An erased tombstone keeps its relationships: a company merge may move it, nothing may refill it.
create or replace function crm_private.guard_erased_identity() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_table_name='contacts' then
  if exists(select 1 from crm_private.contact_erasures where user_id=new.user_id and contact_id=new.id)
   and not (tg_op='UPDATE' and (to_jsonb(new)-array['company_id','version','updated_at'])=(to_jsonb(old)-array['company_id','version','updated_at'])) then
   perform crm_private.fail('CONFLICT','Erased identity cannot be restored');
  end if;
 elsif tg_table_name='outreach_events' then
  if exists(select 1 from crm_private.contact_erasures where user_id=new.user_id and contact_id=new.contact_id) and (new.body<>'' or new.error is not null or new.external_ref is not null) then perform crm_private.fail('CONFLICT','Erased identity cannot be restored');end if;
 elsif tg_table_name='interviews' then
  if new.interviewer_notes<>'' and exists(select 1 from crm_private.contact_erasures where user_id=new.user_id and contact_id=any(new.interviewer_ids)) then perform crm_private.fail('CONFLICT','Erased identity cannot be restored');end if;
 end if;return new;
end $$;
