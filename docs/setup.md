# Setup

This template stops before any external side effect. Each step below is completed by the person deploying the clone.

1. **Install.** Use Node 22+ and Corepack. Run `sh scripts/bootstrap.sh`.
2. **Create local config.** Run `corepack pnpm run init`, then edit `apps/web/.env.local`. Use the publishable Supabase key only.
3. **Provision Supabase.** Create a new project, enable the Auth method you want, configure redirect origins for the final web origin and apply `supabase/migrations` in order. Keep the secret/service key in the provider dashboard or an ignored server env file.
4. **Choose the owner.** Create one account, copy its Auth UUID into `VITE_OWNER_ID`, and configure the database owner settings through the documented owner-only path. Do not seed a person from this repository.
5. **Run locally.** `corepack pnpm db:start`, `corepack pnpm check`, `corepack pnpm build`, then `corepack pnpm dev`. `corepack pnpm local:info` shows the isolated ports.
6. **Connect an agent.** Deploy the MCP function to an HTTPS origin you control. Add that URL in the agent client’s private settings and complete its OAuth flow there. Never commit that URL if it identifies a private deployment.
7. **Add providers one at a time.** Put each provider URL, key, audience and rate limit in an ignored environment file. Start with dry-run/read-only behavior; add writes only after the approval path and replay behavior are tested.

If any provider, account, domain or machine is unavailable, leave the capability disabled and preserve the request as pending.
