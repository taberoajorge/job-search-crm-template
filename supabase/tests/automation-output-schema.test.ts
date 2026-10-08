import postgres from "postgres";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { toolCatalog } from "../../packages/contracts/src/mcp/catalog.ts";
import { outputSchemas } from "../../packages/contracts/src/mcp/output.ts";
import { operation, type OwnerClient } from "../functions/_shared/http.ts";
import { one } from "../functions/_shared/worker.ts";

const owner = "00000000-0000-4000-8000-000000000001";
const ajv = new AjvJsonSchemaValidator();
// The same Ajv check MCP clients such as Claude Code apply to structuredContent.
const published = (name: string) =>
  ajv.getValidator(toolCatalog.find((tool) => tool.name === name)!.outputSchema as never);

Deno.test("automation SQL results reach MCP clients matching the published schema", async () => {
  const command = new Deno.Command("pnpm", {
    args: [
      "exec",
      "supabase",
      "--workdir",
      Deno.env.get("SUPABASE_WORKDIR") ?? ".",
      "status",
      "-o",
      "json",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  if (!result.success) throw new Error("Local Supabase must be running");
  const status = JSON.parse(new TextDecoder().decode(result.stdout));
  if (!["127.0.0.1", "localhost"].includes(new URL(status.DB_URL).hostname))
    throw new Error("Refuse remote integration target");
  const sql = postgres(status.DB_URL, { max: 1 });
  try {
    await sql
      .begin(async (transaction) => {
        const tx = transaction as unknown as ReturnType<typeof postgres>;
        await tx.unsafe(`
          delete from crm_private.settings;
          insert into auth.users(id,email) values('${owner}','owner@example.invalid');
          insert into auth.sessions(id,user_id) values('00000000-0000-4000-8000-000000000010','${owner}');
          insert into crm_private.settings(owner_id,mcp_resource) values('${owner}','https://example.invalid/functions/v1/mcp');
          select set_config('request.jwt.claims','{"sub":"${owner}","session_id":"00000000-0000-4000-8000-000000000010","role":"authenticated","aud":"authenticated"}',true);
        `);
        const [cv] =
          await tx`insert into public.resumes(user_id,label,country,track,checksum,media_type,storage_path,active) values(${owner}::uuid,'Synthetic','Mexico','Frontend',${"a".repeat(64)},'application/pdf',${`${owner}/synthetic.pdf`},true) returning id`;
        const call = async (name: string, input: Record<string, unknown>) => {
          const { raw } = one(
            await tx`select public.crm_operation(${name}, ${tx.json(input as never)}) as raw`,
          );
          // Run the Edge operation path with the RPC answered by the real SQL result.
          const client = {
            rpc: () => Promise.resolve({ data: raw, error: null }),
          } as unknown as OwnerClient;
          const value = await operation(client, name, input);
          const check = published(name)(value);
          if (!check.valid) throw new Error(`${name}: ${check.errorMessage}`);
          // The coordinator parses every result with the contracts baked into its image.
          outputSchemas[name]!.parse(value);
          outputSchemas[name]!.parse(raw); // a new worker against an Edge not yet redeployed
          return { raw, value };
        };
        // A policy stored before discovery/research/jev flags existed: SQL keeps it as-is.
        const legacyPolicy = {
          enabled: true,
          interval_hours: 2,
          revalidate_hours: 24,
          timezone: "America/Mexico_City",
          profiles: [
            {
              id: "frontend-MX",
              country: "MX",
              track: "frontend",
              resume_id: cv!.id,
              checksum: "a".repeat(64),
              authorized_country: true,
              remote: true,
              terms: ["React"],
              exclusions: [],
              allow_unknown_salary: true,
              salary_min: null,
              currency: null,
              salary_period: null,
            },
          ],
          sources: ["autoapply", "openhire"],
          model: "default",
          effort: "medium",
          candidates_per_profile: 3,
          exa_per_run_usd: 0,
          exa_daily_usd: 0,
          exa_monthly_usd: 0,
          digest_email: false,
          closure_email: false,
        };
        const key = () => crypto.randomUUID();
        await call("automation.configure", {
          idempotency_key: key(),
          expected_version: 0,
          policy: legacyPolicy,
        });
        await call("automation.trigger", { idempotency_key: key() });
        const { raw, value } = await call("automation.status", {});
        // Guard that the fixture reproduces the reported failure before the parsed output fixes it.
        if (published("automation.status")(raw).valid)
          throw new Error("Raw status no longer reproduces the legacy schema mismatch");
        const status = value as { policy: { jev_enabled: boolean }; work: { cycle_id: unknown }[] };
        if (status.policy.jev_enabled !== true || !status.work[0]?.cycle_id)
          throw new Error("Status lost the defaulted policy flag or work cycle");
        const executor_id = key();
        const claimed = (await call("automation.claim", { idempotency_key: key(), executor_id }))
          .value as { work: { id: string; lease_token: string; version: number } };
        await call("automation.heartbeat", {
          idempotency_key: key(),
          executor_id,
          status: "online",
        });
        await call("automation.checkpoint", {
          idempotency_key: key(),
          work_id: claimed.work.id,
          lease_token: claimed.work.lease_token,
          expected_version: claimed.work.version,
          state: "waiting",
          checkpoint: {},
          error: null,
          children: [],
        });
        // Guides come from to_jsonb(row), which carries user_id/source_fingerprint/work_id.
        const company = (await call("companies.upsert", { idempotency_key: key(), name: "Acme" }))
          .value as { id: string; version: number };
        const section = {
          explanation_es: "El cliente reserva un servicio.",
          explanation_en: "The customer books a service.",
          coverage: "supported",
          evidence: [
            {
              url: "https://example.invalid/product",
              quote: "Customers book services",
              checked_at: "2026-10-05T00:00:00Z",
            },
          ],
        };
        const content = {
          depth: "interview",
          ...Object.fromEntries(
            [
              "offering",
              "customers",
              "revenue",
              "workflow",
              "technology",
              "hiring_process",
              "example",
            ].map((field) => [field, section]),
          ),
          example_kind: "illustrative",
          gaps: [],
          review_status: "needs_review",
        };
        await tx`insert into public.automation_company_guides(user_id,company_id,version,company_version,content,source_fingerprint,work_id) values(${owner}::uuid,${company.id}::uuid,1,${company.version},${tx.json(content)},${"b".repeat(64)},${claimed.work.id}::uuid)`;
        const guide = await call("automation.company-guide.get", { company_id: company.id });
        // Published schemas tolerate additive fields, so assert the stripping itself: the SQL row
        // carries undeclared columns and the structuredContent the Edge returns does not.
        const undeclared = ["user_id", "source_fingerprint", "work_id"];
        const rawGuide = (guide.raw as { guide?: Record<string, unknown> }).guide ?? {};
        const servedGuide = (guide.value as { guide?: Record<string, unknown> }).guide;
        if (
          !servedGuide ||
          !undeclared.every((key) => key in rawGuide) ||
          undeclared.some((key) => key in servedGuide)
        )
          throw new Error("Guide fixture lost the guide, missed undeclared columns or leaked them");
        // Force rollback even after passing: this harness leaves no synthetic rows behind.
        throw new Error("ROLLBACK_PASSED");
      })
      .catch((e) => {
        if (!(e instanceof Error) || e.message !== "ROLLBACK_PASSED") throw e;
      });
  } finally {
    await sql.end();
  }
});
