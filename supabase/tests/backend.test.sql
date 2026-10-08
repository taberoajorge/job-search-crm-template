\set ON_ERROR_STOP on
create extension if not exists pgtap with schema extensions;
set search_path = public,extensions;
select plan(9);
\ir security.fixture
select pass('Owner RLS, grants, reference validation, transaction rollback, receipts and imports');
\ir advanced.fixture
select pass('Merge/archive history, cursor binding, leases, semantic model isolation and bounded private push');
\ir job-filters.fixture
select pass('Partial company/job/contact search, literal terms, structured filters, pagination and owner isolation');
\ir automation.fixture
select pass('Automation policy, CV isolation, leases, schedule coalescing, budgets, effect replay and protected applications');
\ir company-understanding.fixture
select pass('Company explanations, invitation intent, paused/manual requests, round coalescing and owner isolation');
\ir notifications.fixture
select pass('Notification atomic history, origin, read guards, pagination, consent, immutable email recovery and privacy');
\ir contact-erasure.fixture
select pass('Contact erasure owner review, copy inventory, atomicity and anti-replay');
\ir recent-updates.fixture
select pass('Bounded canonical recent updates, no historical invention and owner isolation');
\ir hardening.fixture
select pass('OAuth catalog boundary, mandatory automation versions, owner contact protection, superseded work recovery, closure-only email scope, claim replay and automation copy erasure');
select * from finish();
