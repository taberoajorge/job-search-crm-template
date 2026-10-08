-- Bind the company's source version just like the job and current CV versions.
do $$
declare definition text;fields text='''resume_version'',''expected_pack_version''';guard text='   select coalesce(max(version),0) into v from public.automation_packs';
begin
 definition=pg_get_functiondef('crm_private.automation_operation(uuid,text,jsonb)'::regprocedure);
 if strpos(definition,fields)=0 or strpos(definition,guard)=0 then raise exception 'Automation dispatcher differs; review before upgrading';end if;
 definition=replace(definition,fields,'''resume_version'',''company_version'',''expected_pack_version''');
 definition=replace(definition,guard,$patch$
   if input->>'company_version' is null or company.version<>(input->>'company_version')::bigint then perform crm_private.fail('CONFLICT','Company facts changed');end if;
$patch$||guard);
 execute definition;
end $$;
