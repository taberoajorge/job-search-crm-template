"""Real connections released together verify retries, versions, leases and budget under contention."""
import concurrent.futures
import json
import os
import subprocess
import shutil
import time
import uuid

URL = os.environ['CRM_TEST_DATABASE_URL']
PSQL = shutil.which('psql') or next((p for p in ('/opt/homebrew/opt/postgresql@17/bin/psql', '/opt/homebrew/opt/postgresql@16/bin/psql') if os.path.exists(p)), 'psql')
OWNER = '00000000-0000-4000-8000-000000000001'
SESSION = '00000000-0000-4000-8000-000000000010'
GATE = 4242
def query(sql):
    result = subprocess.run([PSQL, URL, '-XAt', '-v', 'ON_ERROR_STOP=1', '-c', sql], text=True, capture_output=True, check=True)
    return result.stdout.strip().splitlines()[-1]
def wait_for(sql, expected):
    deadline = time.monotonic() + 60
    while query(sql) != expected:
        assert time.monotonic() < deadline, f'timeout waiting for {expected}: {sql}'
        time.sleep(0.05)
# Each call waits on a shared gate lock, so all calls start inside the database at the same moment.
def rpc(op, args, gate=False):
    claims = json.dumps({'sub': OWNER, 'session_id': SESSION, 'role': 'authenticated'})
    payload = json.dumps(args).replace("'", "''")
    wait = f'select pg_advisory_xact_lock_shared({GATE}); ' if gate else ''
    result = subprocess.run([PSQL, URL, '-XAtq', '-v', 'ON_ERROR_STOP=1', '-c', f"begin; set local role authenticated; set local request.jwt.claims='{claims}'; {wait}select public.crm_operation('{op}','{payload}'::jsonb); commit;"], text=True, capture_output=True, check=True)
    return json.loads(result.stdout.strip().splitlines()[-1])
def together(calls):
    holder = subprocess.Popen([PSQL, URL, '-XAtq', '-c', f'select pg_advisory_lock({GATE}); select pg_sleep(120);'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    locks = f"select count(*) from pg_locks where locktype='advisory' and objid={GATE}"
    wait_for(f'{locks} and granted', '1')
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(calls)) as pool:
        futures = [pool.submit(rpc, op, args, True) for op, args in calls]
        wait_for(f'{locks} and not granted', str(len(calls)))
        query(f"select pg_terminate_backend(pid) from pg_locks where locktype='advisory' and objid={GATE} and granted")
        results = [f.result() for f in futures]
    holder.wait()
    return results
key = lambda: str(uuid.uuid4())
query(f"insert into auth.users(id,email) values('{OWNER}','concurrency@example.invalid'); insert into auth.sessions(id,user_id) values('{SESSION}','{OWNER}'); insert into crm_private.settings(owner_id,mcp_resource) values('{OWNER}','https://example.invalid/functions/v1/mcp');")
payload = {'name': 'Once', 'idempotency_key': key()}
results = together([('companies.upsert', payload)] * 2)
assert results[0] == results[1] and 'error' not in results[0], results
target = results[0]['id']
assert query("select count(*) from public.companies where name='Once'") == '1'
assert query("select count(*) from public.audit_events where entity_type='companies'") == '1'
results = together([('companies.upsert', {'id': target, 'expected_version': 1, 'name': f'Write {n}', 'idempotency_key': key()}) for n in range(2)])
assert sum('error' not in r for r in results) == 1, results
assert sum(r.get('error', {}).get('code') == 'CONFLICT' for r in results) == 1, results
cv = query(f"with cv as (insert into public.resumes(user_id,label,country,track,checksum,media_type,storage_path,active) values('{OWNER}','Synthetic','Mexico','Frontend','{'d' * 64}','application/pdf','{OWNER}/concurrency.pdf',true) returning id) select id from cv")
profile = {'id': 'frontend-MX', 'country': 'MX', 'track': 'frontend', 'resume_id': cv, 'checksum': 'd' * 64, 'authorized_country': True, 'remote': True, 'terms': ['React'], 'exclusions': [], 'allow_unknown_salary': True, 'salary_min': None, 'currency': None, 'salary_period': None}
policy = {'enabled': True, 'interval_hours': 2, 'revalidate_hours': 24, 'timezone': 'UTC', 'profiles': [profile], 'sources': ['autoapply', 'openhire', 'exa'], 'model': 'default', 'effort': 'medium', 'candidates_per_profile': 3, 'exa_per_run_usd': 0.1, 'exa_daily_usd': 0.1, 'exa_monthly_usd': 1, 'digest_email': False, 'closure_email': False}
assert rpc('automation.configure', {'policy': policy, 'expected_version': 0, 'idempotency_key': key()})['version'] == 1
rpc('automation.trigger', {'idempotency_key': key()})
claims = together([('automation.claim', {'executor_id': key(), 'idempotency_key': key()}) for _ in range(2)])
leased = [c['work'] for c in claims if c.get('work')]
assert len(leased) == 1, claims
work = leased[0]
reserves = together([('automation.reserve', {'work_id': work['id'], 'lease_token': work['lease_token'], 'expected_version': work['version'], 'request_id': key(), 'amount_usd': 0.1, 'idempotency_key': key()}) for _ in range(2)])
assert sum('error' not in r for r in reserves) == 1, reserves
assert query('select count(*) from public.automation_reservations') == '1'
print('Concurrent receipts, versions, leases and budget reservations passed')
