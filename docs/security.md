# Security boundary

The public tree is intentionally credential-free. `.env`, `.env.local`, `.supabase`, `.local`, generated artifacts, signed document URLs and provider credentials are ignored. A browser build accepts only a Supabase URL, a publishable key and an owner UUID; server-only keys belong in Edge/server environment configuration.

RLS and the owner authorization function protect records. Edge handlers verify bearer tokens, reject wrong audiences, cap request bodies, validate contracts and return no raw rows. Writes require idempotency; updates require versions; document links expire after five minutes. The frontend never uses a service key.

The repository contains migrations and test fixtures only; it does not contain a database export, seed data, account, CV or production row. The root legacy `index.html` is intentionally absent. A fresh local Supabase stack has seeding disabled and OAuth dynamic registration disabled; enable those features only after configuring the deployment and its redirect allowlist.

Before publishing a configured deployment, run a secret scanner, inspect the built HTML/CSP, review Auth redirect origins and remove unused provider scopes. A successful local check proves code behavior only; it does not prove a provider’s account, OAuth or network configuration.
