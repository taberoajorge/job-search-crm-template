# Public CRM template

This repository is a configurable, single-owner job-search CRM template. It contains no deployed endpoint, account, user data or provider credential. Keep all secrets in ignored environment files and keep the browser on publishable keys plus Supabase RLS.

## Setup

Run `sh scripts/bootstrap.sh`, copy `apps/web/.env.example` to `apps/web/.env.local`, fill the values, then run `corepack pnpm check` and `corepack pnpm build`. `corepack pnpm db:start` starts an isolated local Supabase stack; it requires Docker.

## Operating rules

- Treat the database and its RLS policies as the source of truth.
- Every mutation carries a fresh idempotency key; every update carries `expected_version`. Preserve drafts and ambiguous requests.
- Use owner JWTs and publishable keys in public clients. Never put an administrative key in browser code, fixtures or committed files.
- Do not infer job relationships, salary, eligibility, delivery or application state. Keep unknowns explicit.
- Store external messages and applications as records or drafts. Sending requires a separate, explicit integration and approval.
- Keep signed document downloads short lived; the template uses a five-minute ceiling.
- Use native controls and CSS first. Verify keyboard/focus behavior, reduced effects and 360/390/768/1440 layouts.
- Run `corepack pnpm check`, `corepack pnpm build` and `corepack pnpm check:edge` before review.

The public workflow skill lives at `.agents/skills/crm-workflow/SKILL.md`. Client adapters in `.claude/skills` point to the same workflow.
