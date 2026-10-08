# Job Search CRM Template

A provider-neutral starter for a private job-search CRM. It includes the React interface, shared TypeScript contracts, Supabase migrations and owner-authenticated MCP/Edge handlers from the workflow. It is designed to be configured by the person who clones it; this repository ships no live URL, account, personal record, credential, deployment target or machine path.

## Quick start

Requirements: Node 22+, Corepack/pnpm 10.33+, Docker for the local database, and Deno 2.9+ for Edge checks.

```sh
sh scripts/bootstrap.sh
corepack pnpm run init
# edit apps/web/.env.local when the script asks you to
corepack pnpm db:start
corepack pnpm check
corepack pnpm build
corepack pnpm dev
```

`pnpm run init` is a local configuration helper: it creates missing env files and prints the next manual steps. It never creates an account, calls a provider, deploys anything or writes a secret. Follow [docs/setup.md](docs/setup.md) for the full sequence.

## What to configure

1. Create a separate Supabase project for this clone, enable email or another supported Auth method, and apply the migrations.
2. Create the first user in that project and put its Auth UUID in `VITE_OWNER_ID`. The backend keeps owner access behind RLS and the owner authorization function.
3. Set `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` and `CRM_ALLOWED_ORIGINS` in ignored env files.
4. If an agent client will use MCP, deploy the Edge function yourself and add its URL to that client’s private configuration. This repo intentionally contains no MCP endpoint.
5. Add research, email, storage or messaging providers only as optional adapters after reviewing their terms, scopes, retention and approval prompts. Nothing in this template sends externally by default.

## Method

The workflow is: establish the user’s constraints → read canonical records and pagination → research with sources and timestamps → preserve unknowns and drafts → mutate with idempotency/version guards → read back and report evidence. The agent skill repeats this method for any supported client. See [docs/methodology.md](docs/methodology.md) and [docs/security.md](docs/security.md).

## Checks

```sh
corepack pnpm check
corepack pnpm build
corepack pnpm check:edge
```

Local data, env files, generated artifacts and service state are ignored. Do not add production exports, signed URLs, CVs or client credentials to this repository.
