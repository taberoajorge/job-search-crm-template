import { Client, StreamableHTTPClientTransport } from "npm:@modelcontextprotocol/client@2.3.0";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { decodeJwt, importJWK, SignJWT } from "jose";
import { handler as mcpHandler } from "../functions/mcp/index.ts";
import { handler as crmHandler } from "../functions/crm/index.ts";
import { allowedEndpoint } from "../functions/push/index.ts";
import { handler as worker } from "../functions/worker/index.ts";
import { one, workerAuth } from "../functions/_shared/worker.ts";
const mcp =
  Deno.env.get("CRM_EDGE_HTTP") === "true"
    ? (req: Request) => fetch(req, { signal: AbortSignal.timeout(20000) })
    : mcpHandler;
const crm =
  Deno.env.get("CRM_EDGE_HTTP") === "true"
    ? (req: Request) => fetch(req, { signal: AbortSignal.timeout(20000) })
    : crmHandler;
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function rpc(response: Response) {
  const text = await response.text();
  if (response.headers.get("Content-Type")?.includes("text/event-stream")) {
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    assert(data, "SSE result must contain a JSON-RPC message");
    return JSON.parse(data.slice(6));
  }
  return JSON.parse(text);
}
function req(url: string, bearer?: string, value?: unknown, extra: HeadersInit = {}) {
  return new Request(url, {
    method: value === undefined ? "GET" : "POST",
    headers: {
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      "Content-Type": "application/json",
      Accept: "application/json,text/event-stream",
      ...extra,
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}
Deno.test({
  name: "Real local Supabase OAuth PKCE, resource audience, MCP protocol, private Storage and revocation",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const statusResult = await new Deno.Command("pnpm", {
      args: [
        "exec",
        "supabase",
        "status",
        "-o",
        "json",
        ...(Deno.env.get("SUPABASE_WORKDIR")
          ? ["--workdir", Deno.env.get("SUPABASE_WORKDIR")!]
          : []),
      ],
      stdout: "piped",
      stderr: "null",
    }).output();
    assert(statusResult.success, "Start the local Supabase stack first");
    const status = JSON.parse(new TextDecoder().decode(statusResult.stdout));
    assert(
      ["127.0.0.1", "localhost"].includes(new URL(status.API_URL).hostname),
      "Integration tests must never target a remote project",
    );
    const config = await Deno.readTextFile(
      `${Deno.env.get("SUPABASE_WORKDIR") ?? "."}/supabase/config.toml`,
    );
    const projectID = config.match(/^project_id\s*=\s*"([^"]+)"/m)?.[1];
    assert(projectID, "Local Supabase project ID");
    const dbURL = new URL(status.DB_URL);
    assert(
      ["127.0.0.1", "localhost"].includes(dbURL.hostname),
      "Integration tests must never mutate a remote database",
    );
    Deno.env.set("SUPABASE_URL", status.API_URL);
    Deno.env.set("SUPABASE_ANON_KEY", status.ANON_KEY);
    const resource = `${status.API_URL}/functions/v1/mcp`;
    Deno.env.set("MCP_RESOURCE_URL", resource);
    const url = `${status.API_URL}/functions/v1/crm`;
    const sql = postgres(status.DB_URL, { max: 1 });
    const oldSettings = await sql`select * from crm_private.settings`;
    const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const user = createClient(status.API_URL, status.ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const email = `edge-${crypto.randomUUID()}@example.invalid`,
      password = crypto.randomUUID() + "!Aa9";
    let owner = "",
      clientID = "",
      filePath = "",
      workerRole = "",
      otherOwner = "";
    try {
      const created = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      assert(!created.error && created.data.user, "Local test owner must be created");
      owner = created.data.user.id;
      await sql`delete from crm_private.settings`;
      await sql`insert into crm_private.settings(owner_id,mcp_resource) values(${owner}::uuid,${resource})`;
      const appOrigin = config.match(/^site_url\s*=\s*"([^"]+)"/m)?.[1] ?? "http://localhost:5173";
      const consentRedirect = `${appOrigin}/oauth/consent?authorization_id=local-redirect-check`;
      const otp = await user.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false, emailRedirectTo: consentRedirect },
      });
      assert(!otp.error, "Local OTP request");
      let mailHTML = "";
      for (let attempt = 0; attempt < 10 && !mailHTML; attempt++) {
        const mailboxResponse = await fetch(
          `${status.MAILPIT_URL ?? status.INBUCKET_URL}/api/v1/messages`,
        );
        const mailbox = await mailboxResponse.json();
        const message = mailbox.messages?.find((m: { To?: { Address: string }[] }) =>
          m.To?.some((recipient) => recipient.Address === email),
        );
        if (message) {
          const detailResponse = await fetch(
            `${status.MAILPIT_URL ?? status.INBUCKET_URL}/api/v1/message/${message.ID}`,
          );
          const detail = await detailResponse.json();
          mailHTML = detail.HTML ?? detail.Text ?? "";
        }
        if (!mailHTML) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const verifyLink = mailHTML
        .match(/https?:[^"<>\s]*\/auth\/v1\/verify[^"<>\s]*/)?.[0]
        ?.replace(/&amp;/g, "&");
      assert(
        verifyLink && new URL(verifyLink).searchParams.get("redirect_to") === consentRedirect,
        "Actual OTP email must preserve consent authorization_id",
      );
      const signed = await user.auth.signInWithPassword({ email, password });
      assert(!signed.error && signed.data.session, `Owner login failed: ${signed.error?.message}`);
      const otherEmail = `edge-other-${crypto.randomUUID()}@example.invalid`;
      const other = await admin.auth.admin.createUser({
        email: otherEmail,
        password,
        email_confirm: true,
      });
      assert(other.data.user, "Other local fixture user");
      otherOwner = other.data.user.id;
      const otherClient = createClient(status.API_URL, status.ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const forbiddenLogin = await otherClient.auth.signInWithPassword({
        email: otherEmail,
        password,
      });
      assert(
        forbiddenLogin.error && !forbiddenLogin.data.session,
        "Auth hook must reject non-owner login",
      );
      const forbiddenSignup = await otherClient.auth.signUp({
        email: `signup-${crypto.randomUUID()}@example.invalid`,
        password,
      });
      assert(forbiddenSignup.error, "Open signup must be disabled");
      const bearer = signed.data.session.access_token;
      const claims = decodeJwt(bearer);
      assert(
        claims.aud === "authenticated" ||
          (Array.isArray(claims.aud) && claims.aud.includes("authenticated")),
        "Browser token audience: " +
          JSON.stringify({ aud: claims.aud, client_id: claims.client_id }),
      );
      const issuer = String(claims.iss);
      Deno.env.set("CRM_JWT_ISSUER", issuer);
      let response = await crm(
        req(url, bearer, {
          operation: "companies.upsert",
          input: { name: "Edge smoke", idempotency_key: crypto.randomUUID() },
        }),
      );
      const company = await rpc(response);
      assert(company.id && !company.error, `CRM output failed: ${JSON.stringify(company)}`);
      response = await crm(
        req(url, bearer, {
          operation: "jobs.upsert",
          input: {
            company_id: company.id,
            title: "Runtime Engineer",
            posting_url: "HTTPS://EXAMPLE.invalid/Posting?id=1&utm_source=feed",
            idempotency_key: crypto.randomUUID(),
          },
        }),
      );
      const firstJob = await rpc(response);
      assert(
        firstJob.id && !firstJob.error && firstJob.duplicate_hints.length === 0,
        "Typed job creation and review hints",
      );
      async function privacyOperation(name: string, input: unknown) {
        return rpc(await crm(req(url, bearer, { operation: name, input })));
      }
      const contactIntent = {
        company_id: company.id,
        name: "Synthetic privacy fixture",
        email: "privacy@example.invalid",
        idempotency_key: crypto.randomUUID(),
      };
      const contactResult = await privacyOperation("contacts.upsert", contactIntent);
      assert(contactResult.contact?.id, "Synthetic contact created through typed Edge");
      const preview = await privacyOperation("contacts.preview_erasure", {
        id: contactResult.contact.id,
      });
      assert(preview.inventory?.contact === 1 && preview.inventory_hash, "Typed privacy inventory");
      const eraseIntent = {
        id: preview.contact_id,
        expected_version: preview.expected_version,
        inventory_hash: preview.inventory_hash,
        owner_reviewed: true,
        idempotency_key: crypto.randomUUID(),
      };
      const rejected = await privacyOperation("contacts.erase", {
        id: preview.contact_id,
        confirmation: true,
        idempotency_key: crypto.randomUUID(),
      });
      assert(rejected.error?.code === "VALIDATION_ERROR", "Agent confirmation alone fails");
      const erased = await privacyOperation("contacts.erase", eraseIntent);
      assert(erased.erased === true, "Typed synthetic canonical erasure");
      const eraseReplay = await privacyOperation("contacts.erase", eraseIntent);
      assert(JSON.stringify(eraseReplay) === JSON.stringify(erased), "Exact erasure replay");
      const oldContactReplay = await privacyOperation("contacts.upsert", contactIntent);
      assert(
        oldContactReplay.contact?.erased === true && !oldContactReplay.contact.email,
        "Old Edge receipt passes typed minimized replay output",
      );
      const dashboard = await privacyOperation("dashboard.summary", {});
      assert(
        Array.isArray(dashboard.recent_updates?.items) && dashboard.workspace?.featured_jobs,
        "Typed bounded summary projections",
      );
      response = await crm(
        req(url, bearer, {
          operation: "jobs.upsert",
          input: {
            company_id: company.id,
            title: "Runtime Engineer",
            posting_url: "https://example.invalid/Posting?id=1&utm_medium=feed",
            idempotency_key: crypto.randomUUID(),
          },
        }),
      );
      const secondJob = await rpc(response);
      assert(
        secondJob.id !== firstJob.id && secondJob.duplicate_hints.includes(firstJob.id),
        "Suspected duplicates retain distinct immutable IDs",
      );
      response = await mcp(req(resource, undefined, { jsonrpc: "2.0", id: 1, method: "ping" }));
      assert(
        response.status === 401 &&
          response.headers.get("WWW-Authenticate")?.includes("resource_metadata"),
        "Missing bearer challenge",
      );
      await response.body?.cancel();
      response = await mcp(req(`${resource}/.well-known/oauth-protected-resource`));
      const discovery = await rpc(response);
      assert(discovery.resource === resource, "Protected resource metadata");
      response = await mcp(req(resource, bearer, { jsonrpc: "2.0", id: 1, method: "ping" }));
      assert(response.status === 401, "Browser JWT must not substitute for MCP audience");
      await response.body?.cancel();
      const registered = await admin.auth.admin.oauth.createClient({
        client_name: "Local MCP acceptance",
        redirect_uris: ["http://localhost:8765/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
      assert(
        !registered.error && registered.data,
        `OAuth registration failed: ${registered.error?.message}`,
      );
      clientID = registered.data.client_id;
      const verifier = crypto.randomUUID() + crypto.randomUUID();
      const hash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
      );
      const challenge = btoa(String.fromCharCode(...hash))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      const params = new URLSearchParams({
        response_type: "code",
        client_id: clientID,
        redirect_uri: "http://localhost:8765/callback",
        state: "local-state",
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "openid",
      });
      response = await fetch(`${status.API_URL}/auth/v1/oauth/authorize?${params}`, {
        redirect: "manual",
      });
      const location = response.headers.get("Location");
      await response.body?.cancel();
      assert(location, "OAuth authorize must redirect to consent");
      const authorizationID = new URL(location).searchParams.get("authorization_id");
      assert(authorizationID, "Consent authorization ID");
      const details = await user.auth.oauth.getAuthorizationDetails(authorizationID);
      assert(!details.error, "OAuth consent details");
      const approved = await user.auth.oauth.approveAuthorization(authorizationID, {
        skipBrowserRedirect: true,
      });
      assert(!approved.error && approved.data, `OAuth consent failed: ${approved.error?.message}`);
      const code = new URL(approved.data.redirect_url).searchParams.get("code");
      assert(code, "OAuth authorization code");
      const exchange = async (values: Record<string, string>) => {
        const response = await fetch(`${status.API_URL}/auth/v1/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(values),
        });
        const value = await rpc(response);
        assert(
          response.ok && value.access_token,
          `OAuth token exchange failed: ${value.error ?? value.message}`,
        );
        return value;
      };
      const oauth = await exchange({
        grant_type: "authorization_code",
        code,
        client_id: clientID,
        redirect_uri: "http://localhost:8765/callback",
        code_verifier: verifier,
      });
      assert(decodeJwt(oauth.access_token).aud === resource, "OAuth hook resource audience");
      const oauthClient = createClient(status.API_URL, status.ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${oauth.access_token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const read = await oauthClient.rpc("crm_operation", {
        p_operation: "companies.list",
        p_input: {},
      });
      assert(
        !read.error && read.data.items.length === 1,
        `Resource JWT must work with PostgREST: ${read.error?.message}`,
      );
      // The MCP grant must not reach UI-only operations through PostgREST either (contracts-001).
      for (const name of ["companies.merge", "companies.archive", "push.subscribe"]) {
        const sideDoor = await oauthClient.rpc("crm_operation", {
          p_operation: name,
          p_input: { confirmation: true },
        });
        assert(
          !sideDoor.error && sideDoor.data?.error?.code === "FORBIDDEN",
          `MCP OAuth token cannot call ${name} directly: ${JSON.stringify(sideDoor.data ?? sideDoor.error)}`,
        );
      }
      const authUser = await oauthClient.auth.getUser(oauth.access_token);
      assert(
        !authUser.error && authUser.data.user.id === owner,
        "Resource JWT must work with Auth getUser",
      );
      for (const method of ["initialize", "tools/list", "ping"]) {
        response = await mcp(
          req(resource, oauth.access_token, {
            jsonrpc: "2.0",
            id: 2,
            method,
            params: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "local", version: "1" },
            },
          }),
        );
        const result = await rpc(response);
        assert(
          response.status === 200 && result.result,
          `MCP ${method}: ${JSON.stringify(result)}`,
        );
        assert(
          result.result.resultType === undefined && result.result.ttlMs === undefined,
          "Legacy result shape has no modern cache/envelope fields",
        );
        if (method === "tools/list") {
          assert(
            result.result.tools.length === 46 &&
              !result.result.tools.some((t: { name: string }) =>
                ["companies.merge", "companies.archive"].includes(t.name),
              ) &&
              result.result.tools.some((t: { name: string }) => t.name === "companies.health") &&
              result.result.tools.every((t: { outputSchema?: unknown }) => t.outputSchema),
            "Full typed catalog",
          );
        }
      }
      for (const version of ["2025-06-18", "2025-03-26"]) {
        response = await mcp(
          req(
            resource,
            oauth.access_token,
            {
              jsonrpc: "2.0",
              id: version,
              method: "initialize",
              params: {
                protocolVersion: version,
                capabilities: {},
                clientInfo: { name: "legacy-smoke", version: "1" },
              },
            },
            { "MCP-Protocol-Version": version },
          ),
        );
        assert(
          (await rpc(response)).result?.protocolVersion === version,
          "Existing legacy revision retained",
        );
      }
      const modern = async (
        method: string,
        params: Record<string, unknown> = {},
        headers: HeadersInit = {},
      ) => {
        return mcp(
          req(
            resource,
            oauth.access_token,
            {
              jsonrpc: "2.0",
              id: `modern-${method}`,
              method,
              params: {
                ...params,
                _meta: {
                  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                  "io.modelcontextprotocol/clientCapabilities": {},
                },
              },
            },
            {
              "MCP-Protocol-Version": "2026-07-28",
              "MCP-Method": method,
              ...(typeof params.name === "string" ? { "MCP-Name": params.name } : {}),
              ...(method === "resources/read" && typeof params.uri === "string"
                ? { "MCP-Name": params.uri }
                : {}),
              ...headers,
            },
          ),
        );
      };
      for (const method of ["server/discover", "tools/list"]) {
        response = await modern(method);
        const message = await rpc(response);
        assert(
          response.status === 200 && message.result?.resultType === "complete",
          `Modern ${method}: ${JSON.stringify(message)}`,
        );
        assert(
          message.result.cacheScope === "private" && message.result.ttlMs === 0,
          "Private cache metadata",
        );
      }
      response = await modern("tools/list", {}, { "MCP-Method": "tools/call" });
      assert((await rpc(response)).error?.code === -32020, "Mirrored method mismatch");
      response = await modern("tools/call", { name: "companies.list", arguments: {} });
      const modernRead = await rpc(response);
      assert(
        modernRead.result?.resultType === "complete" &&
          modernRead.result.structuredContent.items.length === 1,
        "Modern typed read",
      );
      for (const mode of ["auto", "legacy"] as const) {
        const official = new Client(
          { name: "isolated-crm-conformance", version: "1" },
          { versionNegotiation: { mode } },
        );
        const transport = new StreamableHTTPClientTransport(new URL(resource), {
          requestInit: { headers: { Authorization: `Bearer ${oauth.access_token}` } },
          fetch: async (input, init) => mcp(new Request(input, init)),
        });
        try {
          await official.connect(transport);
          assert(
            official.getProtocolEra() === (mode === "auto" ? "modern" : "legacy"),
            `Official ${mode} negotiated era`,
          );
          assert(
            official.getNegotiatedProtocolVersion() ===
              (mode === "auto" ? "2026-07-28" : "2025-11-25"),
            `Official ${mode} revision`,
          );
          const catalog = await official.listTools();
          assert(
            catalog.tools.length === 46 &&
              !catalog.tools.some((tool) => /^(research|monitors)\./.test(tool.name)),
            `Official ${mode} catalog without backend research`,
          );
          assert(
            official.getInstructions()?.includes(".agents/skills/crm-workflow/SKILL.md"),
            "Tool-only fallback points to canonical repository method",
          );
          const caps = official.getServerCapabilities();
          assert(
            caps?.resources && !caps.prompts && !("tasks" in caps),
            "Only implemented capabilities advertised",
          );
          assert(
            Boolean(caps.extensions?.["io.modelcontextprotocol/skills"]) === (mode === "auto"),
            "Skills only declared in modern era",
          );
          assert(
            (await official.listResources()).resources.length === 5,
            `Official ${mode} resources`,
          );
          const notifications = await official.callTool({
            name: "notifications.list",
            arguments: { limit: 1 },
          });
          assert(
            !notifications.isError && notifications.structuredContent,
            `Official ${mode} typed notification read`,
          );
          const invalidNotification = await official.callTool({
            name: "notifications.read",
            arguments: { id: owner, read: true, idempotency_key: crypto.randomUUID() },
          });
          assert(invalidNotification.isError, "Notification mutation requires expected_version");
          const read = await official.readResource({ uri: "skill://crm-workflow/SKILL.md" });
          assert(
            read.contents.length === 1 && "text" in read.contents[0]!,
            `Official ${mode} workflow read`,
          );
          assert(
            !(await official.callTool({ name: "companies.list", arguments: {} })).isError,
            `Official ${mode} typed read`,
          );
        } finally {
          await official.close();
        }
      }
      response = await modern("skills/list");
      const listing = (await rpc(response)).result;
      assert(
        listing.skills.length === 1 && listing.cacheScope === "private" && listing.ttlMs === 0,
        "Skills manifest private and bounded",
      );
      const skill = listing.skills[0];
      response = await modern("skills/get", { uri: skill.uri });
      assert(
        JSON.stringify((await rpc(response)).result.skill) === JSON.stringify(skill),
        "Skills get matches list",
      );
      for (const file of skill.resources) {
        response = await modern("resources/read", { uri: file.uri });
        const resourceMessage = await rpc(response);
        assert(
          resourceMessage.result,
          `Resource read error: ${JSON.stringify(resourceMessage.error)}`,
        );
        const resourceRead = resourceMessage.result;
        assert(
          resourceRead.cacheScope === "private" && resourceRead.ttlMs === 0,
          "Resource cache metadata",
        );
        const bytes = new TextEncoder().encode(resourceRead.contents[0].text);
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
          .map((n) => n.toString(16).padStart(2, "0"))
          .join("");
        assert(
          bytes.length === file.size && `sha256:${digest}` === file.digest,
          "Manifest hashes served bytes",
        );
      }
      for (const uri of [
        "skill://crm-workflow/../.env",
        "skill://crm-workflow/%2e%2e/.env",
        "file:///etc/passwd",
        "https://example.invalid/private",
        "skill://crm-workflow/private/cv.pdf",
      ]) {
        response = await modern("resources/read", { uri });
        assert((await rpc(response)).error?.code === -32602, "Undeclared URI rejected");
      }
      for (const method of ["tools/list", "resources/list", "skills/list"]) {
        response = await modern(method, { cursor: "unknown" });
        assert((await rpc(response)).error?.code === -32602, "Unknown pagination cursor rejected");
      }
      response = await modern("skills/get", { uri: "skill://unknown/SKILL.md" });
      assert((await rpc(response)).error?.code === -32602, "Unknown skill rejected");
      response = await modern("tools/call", { name: "companies.archive", arguments: {} });
      assert((await rpc(response)).error?.code === -32602, "Modern allowlist enforced");
      response = await modern(
        "tools/call",
        { name: "companies.list", arguments: {} },
        { "MCP-Name": "jobs.list" },
      );
      assert((await rpc(response)).error?.code === -32020, "Mirrored tool name mismatch");
      for (const metadata of [
        null,
        {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": "bad",
        },
        {
          "io.modelcontextprotocol/protocolVersion": "2099-01-01",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      ]) {
        response = await mcp(
          req(
            resource,
            oauth.access_token,
            { jsonrpc: "2.0", id: "bad-meta", method: "tools/list", params: { _meta: metadata } },
            {
              "MCP-Protocol-Version":
                metadata?.["io.modelcontextprotocol/protocolVersion"] ?? "2026-07-28",
              "MCP-Method": "tools/list",
            },
          ),
        );
        const message = await rpc(response);
        assert(message.error && !message.result, "Malformed or unsupported metadata rejected");
        if (metadata?.["io.modelcontextprotocol/protocolVersion"] === "2099-01-01")
          assert(message.error.code === -32022, "Unknown modern version error");
      }
      response = await mcp(
        req(resource, oauth.access_token, {
          jsonrpc: "2.0",
          id: "oversize-resource",
          method: "resources/read",
          params: { uri: "x".repeat(1048577) },
        }),
      );
      assert(response.status === 413, "Oversize resource request bounded before dispatch");
      await response.body?.cancel();
      const sourceInput = {
        name: "Synthetic protocol replay",
        kind: "manual",
        idempotency_key: crypto.randomUUID(),
      };
      response = await modern("tools/call", { name: "sources.upsert", arguments: sourceInput });
      const receipt = (await rpc(response)).result.structuredContent;
      assert(!receipt.error && receipt.id && receipt.version, "Synthetic source creation");
      response = await modern("tools/call", { name: "sources.upsert", arguments: sourceInput });
      assert(
        JSON.stringify((await rpc(response)).result.structuredContent) === JSON.stringify(receipt),
        "Mutation replay returns permanent receipt",
      );
      response = await modern("tools/call", {
        name: "sources.upsert",
        arguments: { ...sourceInput, name: "Different intention" },
      });
      assert(
        (await rpc(response)).result.structuredContent.error?.code === "IDEMPOTENCY_CONFLICT",
        "Changed payload cannot reuse a permanent key",
      );
      response = await modern("tools/call", {
        name: "sources.upsert",
        arguments: {
          id: receipt.id,
          expected_version: receipt.version + 10,
          name: "Preserve draft",
          idempotency_key: crypto.randomUUID(),
        },
      });
      assert(
        (await rpc(response)).result.structuredContent.error?.code === "CONFLICT",
        "Stale version preserves server state",
      );
      for (const name of ["companies.merge", "companies.archive"]) {
        response = await mcp(
          req(resource, oauth.access_token, {
            jsonrpc: "2.0",
            id: `blocked-${name}`,
            method: "tools/call",
            params: { name, arguments: { confirmation: true } },
          }),
        );
        const blocked = await rpc(response);
        assert(
          blocked.error?.code === -32602 && !blocked.result,
          "Removed cascade tools reject manual calls before business dispatch",
        );
      }
      response = await mcp(
        req(resource, oauth.access_token, {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "companies.list", arguments: {} },
        }),
      );
      const result = await rpc(response);
      assert(
        result.result.structuredContent.items.length === 1 && !result.result.isError,
        "MCP typed read result",
      );
      response = await mcp(
        req(resource, oauth.access_token, {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "jobs.upsert", arguments: { stage: "interviewing" } },
        }),
      );
      const invalid = await rpc(response);
      assert(
        invalid.result.isError &&
          invalid.result.structuredContent.error.code === "VALIDATION_ERROR",
        "MCP domain errors distinct from JSON-RPC errors",
      );
      response = await mcp(
        req(
          resource,
          oauth.access_token,
          {
            jsonrpc: "2.0",
            id: 5,
            method: "ping",
          },
          { "MCP-Protocol-Version": "bad-version" },
        ),
      );
      assert(response.status === 400, "Protocol rejection");
      await response.body?.cancel();
      response = await mcp(
        req(resource, oauth.access_token, {
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      );
      assert(response.status === 202, "Notifications accepted");
      response = await mcp(req(resource, oauth.access_token));
      assert(response.status === 405, "Stateless GET SSE rejected explicitly");
      response = await mcp(
        req(
          resource,
          oauth.access_token,
          {
            jsonrpc: "2.0",
            id: 6,
            method: "ping",
          },
          { Origin: "https://evil.invalid" },
        ),
      );
      assert(response.status === 403, "Origin rejection");
      await response.body?.cancel();
      response = await crm(
        new Request(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bearer}`,
            "Content-Type": "application/json",
          },
          body: "x".repeat(1048577),
        }),
      );
      assert(response.status === 413, "Chunked/actual-byte body bound");
      await response.body?.cancel();
      // Cryptographically signed negative JWTs from the local runtime's own ephemeral signing key.
      const inspected = await new Deno.Command("docker", {
        args: ["inspect", `supabase_auth_${projectID}`],
        stdout: "piped",
        stderr: "null",
      }).output();
      const container = JSON.parse(new TextDecoder().decode(inspected.stdout))[0];
      const keyValue: string | undefined = container.Config.Env.find((e: string) =>
        e.startsWith("GOTRUE_JWT_KEYS="),
      );
      assert(keyValue, "Local signing key fixture available");
      const signing = JSON.parse(keyValue.slice("GOTRUE_JWT_KEYS=".length));
      const jwk = (Array.isArray(signing) ? signing : signing.keys).find(
        (k: { d?: string }) => k.d,
      );
      assert(jwk, "Local private test signing key");
      const signingKey = await importJWK({ ...jwk, key_ops: ["sign"] }, "ES256");
      for (const change of [
        { aud: "https://wrong.invalid" },
        { sub: otherOwner },
        {
          iss: "https://wrong.invalid/auth/v1",
        },
        { exp: Math.floor(Date.now() / 1000) - 60 },
      ]) {
        const forged = await new SignJWT({
          ...decodeJwt(oauth.access_token),
          ...change,
        })
          .setProtectedHeader({ alg: "ES256", kid: jwk.kid })
          .sign(signingKey);
        response = await mcp(req(resource, forged, { jsonrpc: "2.0", id: 7, method: "ping" }));
        assert(
          response.status === (change.sub ? 403 : 401),
          "Expired/foreign owner/wrong issuer/wrong resource rejected",
        );
        await response.body?.cancel();
        if (change.sub) {
          response = await modern(
            "resources/read",
            { uri: skill.uri },
            { Authorization: `Bearer ${forged}` },
          );
          assert(response.status === 403, "Foreign owner cannot read workflow resources");
          await response.body?.cancel();
        }
      }
      const bytes = new TextEncoder().encode("%PDF-1.4\nlocal private test\n%%EOF");
      filePath = `${owner}/${crypto.randomUUID()}.pdf`;
      const uploaded = await user.storage
        .from("resumes")
        .upload(filePath, bytes, { contentType: "application/pdf" });
      assert(!uploaded.error, `Owner Storage upload: ${uploaded.error?.message}`);
      const overwrite = await user.storage
        .from("resumes")
        .upload(filePath, bytes, { contentType: "application/pdf", upsert: true });
      assert(overwrite.error, "Immutable Storage rejects overwrite");
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const metadata = {
        label: "Local CV",
        country: null,
        track: null,
        storage_path: filePath,
        checksum: digest,
        media_type: "application/pdf",
        active: true,
        idempotency_key: crypto.randomUUID(),
      };
      response = await crm(req(url, bearer, { operation: "resumes.finalize", input: metadata }));
      const resume = await rpc(response);
      assert(
        resume.id && !resume.error && !resume.storage_path,
        `Resume finalization: ${JSON.stringify(resume)}`,
      );
      response = await mcp(
        req(resource, oauth.access_token, {
          jsonrpc: "2.0",
          id: 81,
          method: "tools/call",
          params: { name: "resumes.finalize", arguments: metadata },
        }),
      );
      const replayedResume = await rpc(response);
      assert(
        replayedResume.result.structuredContent.id === resume.id && !replayedResume.result.isError,
        "MCP finalization replays the same verified registration without a duplicate",
      );
      response = await mcp(
        req(resource, oauth.access_token, {
          jsonrpc: "2.0",
          id: 82,
          method: "tools/call",
          params: {
            name: "resumes.finalize",
            arguments: {
              ...metadata,
              checksum: "0".repeat(64),
              idempotency_key: crypto.randomUUID(),
            },
          },
        }),
      );
      const invalidResume = await rpc(response);
      assert(
        invalidResume.result.isError &&
          invalidResume.result.structuredContent.error.code === "VALIDATION_ERROR",
        "MCP cannot register metadata whose checksum differs from owner-uploaded bytes",
      );
      response = await mcp(
        req(resource, oauth.access_token, {
          jsonrpc: "2.0",
          id: 8,
          method: "tools/call",
          params: {
            name: "resumes.get_download",
            arguments: { id: resume.id },
          },
        }),
      );
      const download = await rpc(response);
      assert(
        download.result.structuredContent.expires_in <= 300 &&
          download.result.structuredContent.url,
        "Resource-audience JWT must work with Storage signing",
      );
      // The signed token itself, not just the reported number, must expire within five minutes.
      const signedToken = decodeJwt(
        new URL(download.result.structuredContent.url).searchParams.get("token") ?? "",
      );
      assert(
        typeof signedToken.exp === "number" &&
          typeof signedToken.iat === "number" &&
          signedToken.exp - signedToken.iat <= 300,
        "Signed CV URL lifetime is at most five minutes",
      );
      try {
        response = await fetch(download.result.structuredContent.url, {
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        throw new Error("Private CV public Storage origin unreachable");
      }
      assert(response.ok, "Signed private CV downloads");
      await response.body?.cancel();
      const publicDownload = await createClient(status.API_URL, status.ANON_KEY)
        .storage.from("resumes")
        .download(filePath);
      assert(publicDownload.error, "Anonymous private CV denied");
      workerRole = "crm_test_" + crypto.randomUUID().replace(/-/g, "");
      const workerPassword = crypto.randomUUID();
      const { command } = one(
        await sql`select format('create role %I login inherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication password %L',${workerRole}::text,${workerPassword}::text) command`,
      );
      await sql.unsafe(command);
      await sql`grant crm_worker to ${sql(workerRole)}`;
      const workerURL = new URL(status.DB_URL);
      workerURL.username = workerRole;
      workerURL.password = workerPassword;
      const limited = postgres(workerURL.toString(), { max: 1 });
      try {
        let tablesDenied = false,
          forgedRpcDenied = false;
        try {
          await limited`select * from public.jobs`;
        } catch (e) {
          tablesDenied = (e as { code?: string }).code === "42501";
        }
        try {
          await limited`select set_config('request.jwt.claims',${JSON.stringify({
            sub: owner,
            session_id: claims.session_id,
            role: "authenticated",
          })},false)`;
          await limited`select public.crm_operation('companies.list','{}')`;
        } catch (e) {
          forgedRpcDenied = (e as { code?: string }).code === "42501";
        }
        assert(
          tablesDenied && forgedRpcDenied,
          "Worker LOGIN must reject arbitrary tables and forged owner RPC",
        );
      } finally {
        await limited.end();
      }
      Deno.env.set("CRM_WORKER_DATABASE_URL", workerURL.toString());
      Deno.env.set("CRM_LOCAL_WORKER", "true");
      const workerSecret = crypto.randomUUID();
      Deno.env.set("CRM_WORKER_SECRET", workerSecret);
      response = await crm(
        req(url, bearer, {
          operation: "tasks.submit",
          input: {
            kind: "bulk_import",
            payload: {
              import_namespace: "edge-task",
              records: [
                {
                  entity_type: "companies",
                  legacy_id: "worker-company",
                  data: { id: crypto.randomUUID(), name: "Worker import" },
                },
              ],
            },
            idempotency_key: crypto.randomUUID(),
          },
        }),
      );
      const submitted = await rpc(response);
      assert(
        submitted.task_id && !submitted.error,
        "Durable queued task receipt: " + JSON.stringify(submitted),
      );
      response = await worker(req(`${status.API_URL}/functions/v1/worker`, bearer, {}));
      assert(response.status === 401, "User JWT rejected by actual worker handler");
      await response.body?.cancel();
      // Same length as the real secret, so only the constant-time comparison can reject it.
      response = await worker(
        req(`${status.API_URL}/functions/v1/worker`, crypto.randomUUID(), {}),
      );
      assert(response.status === 401, "Equal-length wrong worker secret rejected");
      await response.body?.cancel();
      response = await worker(req(`${status.API_URL}/functions/v1/worker`, workerSecret, {}));
      const processed = await rpc(response);
      assert(
        response.ok && processed.processed === 1,
        `Restricted-credential worker: ${JSON.stringify(processed)}`,
      );
      response = await crm(
        req(url, bearer, {
          operation: "tasks.get",
          input: { task_id: submitted.task_id },
        }),
      );
      const completed = await rpc(response);
      assert(
        completed.state === "completed" && completed.result.records.length === 1,
        "Durable import completion independently of push",
      );
      const exportedReceipts = await user.from("mutation_receipts").select("response");
      assert(
        !exportedReceipts.error && exportedReceipts.data.length > 0,
        "Owner receipt export SELECT",
      );
      assert(
        exportedReceipts.data.every(
          (r) =>
            !JSON.stringify(r.response).includes("storage_path") &&
            !JSON.stringify(r.response).includes("signedUrl") &&
            !JSON.stringify(r.response).includes("?token="),
        ),
        "Exported receipts contain no private download locations",
      );
      const refresh = await exchange({
        grant_type: "refresh_token",
        refresh_token: oauth.refresh_token,
        client_id: clientID,
      });
      assert(
        decodeJwt(refresh.access_token).aud === resource,
        "OAuth refresh retains resource binding",
      );
      const revocation = await user.auth.oauth.revokeGrant({
        clientId: clientID,
      });
      assert(!revocation.error, "OAuth grant revocation");
      response = await mcp(
        req(resource, refresh.access_token, {
          jsonrpc: "2.0",
          id: 9,
          method: "ping",
        }),
      );
      assert(response.status === 401, "Revoked OAuth access denied before data access");
      for (const [method, params] of [
        ["tools/list", {}],
        ["skills/get", { uri: skill.uri }],
        ["resources/read", { uri: skill.uri }],
      ] as const) {
        response = await modern(method, params);
        assert(response.status === 401, "Cached discovery must not bypass grant revocation");
        await response.body?.cancel();
      }
      const revokedRows = await oauthClient.from("companies").select("id");
      assert(
        !revokedRows.error && revokedRows.data.length === 0,
        "Revoked OAuth cannot directly read RLS tables",
      );
      const revokedFile = await oauthClient.storage.from("resumes").download(filePath);
      assert(revokedFile.error, "Revoked OAuth cannot directly read private Storage");
      await response.body?.cancel();
      assert(
        allowedEndpoint("https://fcm.googleapis.com/push") &&
          !allowedEndpoint("https://127.0.0.1/push") &&
          !allowedEndpoint("https://fcm.googleapis.com@evil.invalid/push"),
        "Push SSRF boundary",
      );
      Deno.env.set("CRM_WORKER_SECRET", crypto.randomUUID());
      let denied = false;
      try {
        workerAuth(req(url, bearer, {}));
      } catch (e) {
        denied = e instanceof Response && e.status === 401;
      }
      assert(denied, "Owner JWT cannot authenticate worker");
    } finally {
      if (filePath) await admin.storage.from("resumes").remove([filePath]);
      if (owner) {
        await sql`delete from crm_private.contact_erasures where user_id=${owner}::uuid`;
        await sql`delete from crm_private.embeddings where user_id=${owner}::uuid`;
        await sql`delete from crm_private.rate_limits where user_id=${owner}::uuid`;
        for (const table of [
          "notification_batches",
          "notification_state",
          "push_deliveries",
          "push_subscriptions",
          "legacy_links",
          "mutation_receipts",
          "audit_events",
          "verifications",
          "interviews",
          "outreach_events",
          "contacts",
          "jobs",
          "resumes",
          "sources",
          "crm_jobs",
          "companies",
        ]) {
          await sql`delete from ${sql("public." + table)} where user_id=${owner}::uuid`;
        }
        await sql`delete from crm_private.settings`;
        for (const cfg of oldSettings) {
          await sql`insert into crm_private.settings(owner_id,mcp_resource) values(${cfg.owner_id}::uuid,${cfg.mcp_resource})`;
        }
        if (clientID) {
          await admin.auth.admin.oauth.deleteClient(clientID);
        }
        await admin.auth.admin.deleteUser(owner);
      }
      if (otherOwner) await admin.auth.admin.deleteUser(otherOwner);
      if (workerRole) await sql`drop role if exists ${sql(workerRole)}`;
      await sql.end();
    }
  },
});
