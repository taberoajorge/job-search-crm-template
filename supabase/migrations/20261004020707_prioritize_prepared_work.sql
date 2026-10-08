-- Finish researched preparations before classifying more legacy radar, then discover new work.
-- ponytail: replace one known fragment; fail closed rather than duplicating the entire dispatcher.
do $$
declare definition text;old_order text='case kind when ''interview'' then 0 when ''research'' then 1 when ''prepare'' then 2 when ''discovery'' then 3 else 4 end';
begin
 definition=pg_get_functiondef('crm_private.automation_operation(uuid,text,jsonb)'::regprocedure);
 if strpos(definition,old_order)=0 then raise exception 'Automation dispatcher differs; review before upgrading';end if;
 definition=replace(definition,old_order,'case kind when ''interview'' then 0 when ''research'' then 1 when ''prepare'' then case when checkpoint->>''needs_profile''=''true'' then 3 else 2 end when ''discovery'' then 4 else 5 end');
 execute definition;
end $$;
