// Edge auth and MCP envelope checks against a local stub of Auth JWKS and PostgREST (no Docker).
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { operation, type OwnerClient } from "../functions/_shared/http.ts";
import { outputSchemas } from "../../packages/contracts/src/mcp/output.ts";
import { handler as mcp } from "../functions/mcp/index.ts";
import { handler as crm } from "../functions/crm/index.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const owner = crypto.randomUUID();
const { privateKey, publicKey } = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(publicKey)), kid: "stub", alg: "ES256", use: "sig" };
const foreign = await generateKeyPair("ES256");

type Stub = {
  base: string;
  resource: string;
  calls: { authorize: number };
  authorize: () => Response;
  operation: (
    auth: string,
    body: { p_operation: string; p_input: unknown },
  ) => Response | Promise<Response>;
  jwks: () => Response;
};
// Each test gets a fresh port, so http.ts's per-URL JWKS cache never leaks keys between cases.
async function withStub(fn: (stub: Stub) => Promise<void>) {
  const stub: Stub = {
    base: "",
    resource: "",
    calls: { authorize: 0 },
    authorize: () => Response.json({ authorized: true }),
    operation: () => Response.json({ items: [], has_more: false, next_cursor: null }),
    jwks: () => Response.json({ keys: [jwk] }),
  };
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/auth/v1/.well-known/jwks.json") return stub.jwks();
    if (path === "/rest/v1/rpc/crm_authorize") {
      stub.calls.authorize++;
      return stub.authorize();
    }
    if (path === "/rest/v1/rpc/crm_operation")
      return stub.operation(req.headers.get("Authorization") ?? "", await req.json());
    return new Response(null, { status: 404 });
  });
  stub.base = `http://127.0.0.1:${server.addr.port}`;
  stub.resource = `${stub.base}/functions/v1/mcp`;
  Deno.env.set("SUPABASE_URL", stub.base);
  Deno.env.set("SUPABASE_ANON_KEY", "stub-anon");
  Deno.env.set("MCP_RESOURCE_URL", stub.resource);
  Deno.env.delete("CRM_JWT_ISSUER");
  Deno.env.delete("CRM_ALLOWED_ORIGINS");
  try {
    await fn(stub);
  } finally {
    await server.shutdown();
  }
}
function token(stub: Stub, claims: Record<string, unknown> = {}, key = privateKey, kid = "stub") {
  return new SignJWT({
    role: "authenticated",
    sub: owner,
    client_id: "stub-client",
    aud: stub.resource,
    iss: `${stub.base}/auth/v1`,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claims,
  })
    .setProtectedHeader({ alg: "ES256", kid })
    .sign(key);
}
function post(url: string, bearer: string | undefined, value: unknown, method = "POST") {
  return new Request(url, {
    method,
    headers: {
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    ...(method === "POST" ? { body: JSON.stringify(value) } : {}),
  });
}
// Legacy stateless replies may arrive as a single SSE event.
async function rpc(response: Response) {
  const text = await response.text();
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(data ? data.slice(6) : text);
}
const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
const call = (name: string, args: unknown, id: unknown = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});
const options = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name: "Auth verifier outages are retryable 503s without an OAuth challenge",
  ...options,
  fn: () =>
    withStub(async (stub) => {
      const bearer = await token(stub);
      stub.jwks = () => new Response("down", { status: 500 });
      const response = await mcp(post(stub.resource, bearer, ping));
      assert(response.status === 503, `JWKS 500 must be 503, got ${response.status}`);
      assert(!response.headers.get("WWW-Authenticate"), "Outage must not challenge re-auth");
      const body = await response.json();
      assert(body.error?.retryable === true, "Outage is retryable");
      const browser = await token(stub, { aud: "authenticated", client_id: undefined });
      Deno.env.set("SUPABASE_URL", "http://127.0.0.1:1");
      const unreachable = await crm(post("https://api.invalid/crm", browser, { operation: "x" }));
      assert(unreachable.status === 503, `Unreachable JWKS must be 503: ${unreachable.status}`);
      await unreachable.body?.cancel();
    }),
});

Deno.test({
  name: "JWT negative matrix: signature, alg, kid, claims and door audience are 401",
  ...options,
  fn: () =>
    withStub(async (stub) => {
      const valid = await token(stub);
      let response = await mcp(post(stub.resource, valid, ping));
      assert(response.status === 200, `Valid MCP token: ${response.status}`);
      await response.body?.cancel();
      const [header, payload] = valid.split(".");
      const hs256 = await new SignJWT({ sub: owner, role: "authenticated", aud: stub.resource })
        .setProtectedHeader({ alg: "HS256" })
        .sign(new TextEncoder().encode("x".repeat(32)));
      const cases: [string, string][] = [
        ["foreign signing key", await token(stub, {}, foreign.privateKey)],
        ["unknown kid", await token(stub, {}, foreign.privateKey, "unknown")],
        ["alg none", `${btoa(JSON.stringify({ alg: "none" })).replace(/=+$/, "")}.${payload}.`],
        ["HS256", hs256],
        ["tampered payload", `${header}.${btoa('{"sub":"x"}').replace(/=+$/, "")}.sig`],
        ["missing sub", await token(stub, { sub: undefined })],
        ["anon role", await token(stub, { role: "anon" })],
        ["missing client_id", await token(stub, { client_id: undefined })],
        ["browser audience", await token(stub, { aud: "authenticated" })],
        ["wrong issuer", await token(stub, { iss: "https://wrong.invalid/auth/v1" })],
        ["expired", await token(stub, { exp: Math.floor(Date.now() / 1000) - 60 })],
      ];
      for (const [label, bearer] of cases) {
        response = await mcp(post(stub.resource, bearer, ping));
        assert(response.status === 401, `${label}: expected 401, got ${response.status}`);
        assert(
          response.headers.get("WWW-Authenticate")?.includes("resource_metadata"),
          `${label}: challenge`,
        );
        await response.body?.cancel();
      }
      response = await crm(post("https://api.invalid/crm", valid, { operation: "x" }));
      assert(response.status === 401, "MCP resource token cannot use the CRM door");
      await response.body?.cancel();
      Deno.env.set("CRM_JWT_ISSUER", "");
      response = await mcp(
        post(stub.resource, await token(stub, { iss: "https://wrong.invalid" }), ping),
      );
      assert(response.status === 401, "Empty issuer setting must not disable the issuer check");
      await response.body?.cancel();
      Deno.env.set("MCP_RESOURCE_URL", "");
      response = await mcp(
        post(stub.resource, await token(stub, { aud: "https://wrong.invalid" }), ping),
      );
      assert(response.status === 401, "Empty resource setting must not disable the audience check");
      await response.body?.cancel();
    }),
});

Deno.test({
  name: "crm_authorize outcomes map to 403, 429 and 503",
  ...options,
  fn: () =>
    withStub(async (stub) => {
      const bearer = await token(stub);
      for (const [reply, status] of [
        [
          () => Response.json({ error: { code: "FORBIDDEN", message: "x", retryable: false } }),
          403,
        ],
        [
          () => Response.json({ error: { code: "RATE_LIMITED", message: "x", retryable: true } }),
          429,
        ],
        [() => Response.json({ message: "db down" }, { status: 500 }), 503],
      ] as const) {
        stub.authorize = reply;
        const response = await mcp(post(stub.resource, bearer, ping));
        assert(response.status === status, `Expected ${status}, got ${response.status}`);
        await response.body?.cancel();
      }
    }),
});

Deno.test({
  name: "GET and DELETE are 405 before any authorization work",
  ...options,
  fn: () =>
    withStub(async (stub) => {
      for (const method of ["GET", "DELETE"]) {
        const response = await mcp(post(stub.resource, undefined, undefined, method));
        assert(response.status === 405, `${method} without token: ${response.status}`);
        await response.body?.cancel();
      }
      assert(stub.calls.authorize === 0, "405 must not call crm_authorize");
      const response = await mcp(post(stub.resource, undefined, ping));
      assert(response.status === 401, "Unauthenticated POST still challenges");
      await response.body?.cancel();
    }),
});

Deno.test({
  name: "JSON-RPC batches spend one rate-limit unit per message",
  ...options,
  fn: () =>
    withStub(async (stub) => {
      const bearer = await token(stub);
      let response = await mcp(
        post(stub.resource, bearer, [ping, { ...ping, id: 2 }, { ...ping, id: 3 }]),
      );
      assert(response.ok, `Batch accepted: ${response.status}`);
      await response.body?.cancel();
      assert(stub.calls.authorize === 3, `Three messages, ${stub.calls.authorize} checks`);
      stub.calls.authorize = 0;
      response = await mcp(
        post(
          stub.resource,
          bearer,
          Array.from({ length: 101 }, (_, id) => ({ ...ping, id })),
        ),
      );
      assert(response.status === 400, `Oversized batch rejected: ${response.status}`);
      assert((await rpc(response)).error?.code === -32600, "Invalid request code");
      assert(stub.calls.authorize === 1, "Oversized batch rejected before per-message checks");
      stub.authorize = () =>
        stub.calls.authorize > 1
          ? Response.json({ error: { code: "RATE_LIMITED", message: "x", retryable: true } })
          : Response.json({ authorized: true });
      stub.calls.authorize = 0;
      response = await mcp(post(stub.resource, bearer, [ping, { ...ping, id: 2 }]));
      assert(response.status === 429, "Batch beyond the limit is refused");
      await response.body?.cancel();
    }),
});

Deno.test({
  name: "isError marks only error envelopes, not records with an error field",
  ...options,
  fn: () =>
    withStub(async (stub) => {
      const bearer = await token(stub);
      const now = new Date().toISOString();
      const failedTask = {
        id: crypto.randomUUID(),
        created_at: now,
        updated_at: now,
        version: 2,
        kind: "bulk_import",
        state: "failed",
        attempts: 3,
        result: null,
        error: { code: "TEMPORARY_FAILURE", message: "Worker lease expired", retryable: false },
        next_attempt_at: null,
      };
      stub.operation = () => Response.json(failedTask);
      let message = await rpc(
        await mcp(post(stub.resource, bearer, call("tasks.get", { task_id: failedTask.id }))),
      );
      assert(
        message.result?.isError === false && message.result.structuredContent.state === "failed",
        `Failed task read is a successful tool call: ${JSON.stringify(message)}`,
      );
      stub.operation = () =>
        Response.json({ error: { code: "NOT_FOUND", message: "x", retryable: false } });
      message = await rpc(
        await mcp(post(stub.resource, bearer, call("tasks.get", { task_id: failedTask.id }))),
      );
      assert(message.result?.isError === true, "Domain error envelope is a tool error");
    }),
});

Deno.test({
  name: "Concurrent MCP requests never share an owner client",
  ...options,
  fn: () =>
    withStub(async (stub) => {
      const subs = [crypto.randomUUID(), crypto.randomUUID()];
      // The stub echoes the caller's token subject; the first caller answers last.
      stub.operation = async (auth) => {
        const sub = JSON.parse(atob(auth.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")))
          .sub as string;
        if (sub === subs[0]) await new Promise((resolve) => setTimeout(resolve, 50));
        const now = new Date().toISOString();
        return Response.json({
          id: crypto.randomUUID(),
          created_at: now,
          updated_at: now,
          version: 1,
          kind: "bulk_import",
          state: "completed",
          attempts: 1,
          result: { sub },
          error: null,
          next_attempt_at: null,
        });
      };
      const replies = await Promise.all(
        subs.map(async (sub) =>
          rpc(
            await mcp(
              post(
                stub.resource,
                await token(stub, { sub }),
                call("tasks.get", { task_id: crypto.randomUUID() }),
              ),
            ),
          ).then((m) => m.result?.structuredContent?.result?.sub ?? JSON.stringify(m)),
        ),
      );
      assert(
        replies[0] === subs[0] && replies[1] === subs[1],
        `Each request uses its own client: ${replies}`,
      );
    }),
});

Deno.test("Contract mismatch after the RPC committed is not reported as retryable", async () => {
  const client = (data: unknown, failure: unknown = null) =>
    ({ rpc: () => Promise.resolve({ data, error: failure }) }) as unknown as OwnerClient;
  const key = crypto.randomUUID();
  const mismatch = await operation(client({ id: "not-a-uuid" }), "sources.upsert", {
    name: "x",
    kind: "manual",
    idempotency_key: key,
  });
  const failure = mismatch.error as { code: string; retryable: boolean; message: string };
  assert(
    failure.code === "TEMPORARY_FAILURE" && failure.retryable === false,
    `Mismatch must not invite a blind retry: ${JSON.stringify(mismatch)}`,
  );
  assert(/read/i.test(failure.message), "Mismatch tells the caller to read current state");
  const unavailable = await operation(client(null, { message: "down" }), "sources.upsert", {
    name: "x",
    kind: "manual",
    idempotency_key: key,
  });
  assert(
    (unavailable.error as { retryable: boolean }).retryable === true,
    "RPC failure before a result stays retryable (idempotent replay)",
  );
});

Deno.test({
  name: "Transport edges: content negotiation, parse errors, CORS, challenges and metadata",
  ...options,
  fn: () =>
    withStub(async (stub) => {
      const bearer = await token(stub);
      const raw = (body: string, headers: HeadersInit, url = stub.resource, method = "POST") =>
        new Request(url, { method, headers, ...(method === "POST" ? { body } : {}) });
      const auth = { Authorization: `Bearer ${bearer}` };
      const browser = {
        Authorization: `Bearer ${await token(stub, { aud: "authenticated", client_id: undefined })}`,
      };
      let response = await mcp(
        raw("{}", {
          ...auth,
          "Content-Type": "text/plain",
          Accept: "application/json, text/event-stream",
        }),
      );
      assert(response.status === 415, `Content-Type gate: ${response.status}`);
      await response.body?.cancel();
      response = await mcp(
        raw("{}", { ...auth, "Content-Type": "application/json", Accept: "application/json" }),
      );
      assert(response.status === 406, `Accept gate: ${response.status}`);
      await response.body?.cancel();
      response = await mcp(
        raw("{", {
          ...auth,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        }),
      );
      assert(
        (await rpc(response)).error?.code === -32700,
        "Malformed JSON is a JSON-RPC parse error",
      );
      response = await mcp(
        raw("x".repeat(1048577), {
          ...auth,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        }),
      );
      assert(
        response.status === 413 && (await rpc(response)).error?.code === -32000,
        "Oversize body answered as JSON-RPC",
      );
      response = await crm(new Request("https://api.invalid/crm", { headers: auth }));
      assert(response.status === 405, "CRM GET is 405");
      await response.body?.cancel();
      response = await crm(
        raw("{", { ...browser, "Content-Type": "application/json" }, "https://api.invalid/crm"),
      );
      assert(response.status === 400, "CRM malformed JSON is 400");
      await response.body?.cancel();
      response = await crm(
        raw(
          JSON.stringify({ operation: "companies.list", input: {}, extra: 1 }),
          browser,
          "https://api.invalid/crm",
        ),
      );
      assert(response.status === 400, "CRM rejects undeclared envelope keys");
      await response.body?.cancel();

      Deno.env.set("CRM_ALLOWED_ORIGINS", "https://job.example.invalid");
      response = await mcp(
        new Request(stub.resource, { method: "POST", headers: { Origin: "https://evil.invalid" } }),
      );
      const denied = await response.json();
      assert(
        response.status === 403 &&
          denied.error?.code === "FORBIDDEN" &&
          response.headers.get("Vary") === "Origin",
        "Foreign origin gets a JSON 403",
      );
      response = await mcp(
        raw(JSON.stringify(ping), {
          ...auth,
          Origin: "https://job.example.invalid",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        }),
      );
      assert(
        response.headers.get("Access-Control-Allow-Origin") === "https://job.example.invalid" &&
          response.headers.get("Vary") === "Origin" &&
          response.headers.get("Access-Control-Expose-Headers")?.includes("WWW-Authenticate") &&
          !response.headers.get("Access-Control-Allow-Methods")?.includes("DELETE"),
        "Allowed origin echoed with exposed challenge header",
      );
      await response.body?.cancel();
      response = await mcp(
        new Request(`${stub.resource}/.well-known/oauth-protected-resource`, {
          headers: { Origin: "https://any.invalid" },
        }),
      );
      const metadata = await response.json();
      assert(
        response.status === 200 &&
          response.headers.get("Access-Control-Allow-Origin") === "*" &&
          metadata.resource === stub.resource,
        "Protected-resource metadata is public to any origin",
      );
      Deno.env.delete("CRM_ALLOWED_ORIGINS");

      response = await mcp(post(stub.resource, undefined, ping));
      let challenge = response.headers.get("WWW-Authenticate") ?? "";
      assert(
        challenge.includes('scope="openid"') && !challenge.includes("error="),
        `Missing token challenge: ${challenge}`,
      );
      await response.body?.cancel();
      response = await mcp(post(stub.resource, await token(stub, { exp: 1 }), ping));
      challenge = response.headers.get("WWW-Authenticate") ?? "";
      assert(challenge.includes('error="invalid_token"'), `Invalid token challenge: ${challenge}`);
      await response.body?.cancel();
      stub.authorize = () =>
        Response.json({ error: { code: "RATE_LIMITED", message: "x", retryable: true } });
      response = await mcp(post(stub.resource, bearer, ping));
      assert(
        response.status === 429 && response.headers.get("Retry-After") === "60",
        "Rate limit tells clients when to retry",
      );
      await response.body?.cancel();
    }),
});

Deno.test("CV finalization verifies upload presence, size, declared type, magic bytes and checksum", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.4\nsynthetic\n%%EOF");
  const digest = async (bytes: Uint8Array<ArrayBuffer>) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  const calls = { rpc: 0 };
  const client = (file: Blob | null) =>
    ({
      storage: {
        from: () => ({
          download: () =>
            Promise.resolve(file ? { data: file, error: null } : { data: null, error: {} }),
        }),
      },
      rpc: () => {
        calls.rpc++;
        return Promise.resolve({
          data: { error: { code: "NOT_FOUND", message: "x", retryable: false } },
          error: null,
        });
      },
    }) as unknown as OwnerClient;
  const input = async (bytes: Uint8Array<ArrayBuffer>, media_type = "application/pdf") => ({
    label: "Synthetic CV",
    country: null,
    track: null,
    storage_path: `${owner}/${crypto.randomUUID()}.pdf`,
    checksum: await digest(bytes),
    media_type,
    active: true,
    idempotency_key: crypto.randomUUID(),
  });
  const code = async (file: Blob | null, value: Record<string, unknown>) =>
    ((await operation(client(file), "resumes.finalize", value)).error as {
      code: string;
      field?: string;
    }) ?? {};
  assert((await code(null, await input(pdf))).code === "NOT_FOUND", "Missing upload");
  assert(
    (await code(new Blob([pdf], { type: "application/msword" }), await input(pdf))).field ===
      "media_type",
    "Stored type differs from declared",
  );
  const text = new TextEncoder().encode("plain text pretending to be a PDF");
  assert(
    (await code(new Blob([text], { type: "application/pdf" }), await input(text))).field ===
      "media_type",
    "Bytes are not a PDF",
  );
  const big = new Uint8Array(10485761);
  big.set(pdf);
  assert(
    (await code(new Blob([big], { type: "application/pdf" }), await input(big))).field ===
      "media_type",
    "Over 10 MiB",
  );
  assert(
    (
      await code(new Blob([pdf], { type: "application/pdf" }), {
        ...(await input(pdf)),
        checksum: "0".repeat(64),
      })
    ).field === "checksum",
    "Checksum mismatch",
  );
  assert(calls.rpc < 1, "Rejected uploads never reach SQL");
  await code(new Blob([pdf], { type: "application/pdf" }), await input(pdf));
  assert(calls.rpc > 0, "Verified upload reaches SQL");
});

Deno.test("CV download link keeps the public base port and path prefix", async () => {
  Deno.env.set("SUPABASE_URL", "http://kong:8000");
  Deno.env.set("CRM_PUBLIC_SUPABASE_URL", "https://example.invalid/supabase");
  try {
    const client = {
      rpc: () => Promise.resolve({ data: { storage_path: `${owner}/cv.pdf` }, error: null }),
      storage: {
        from: () => ({
          createSignedUrl: () =>
            Promise.resolve({
              data: {
                signedUrl: `http://kong:8000/storage/v1/object/sign/resumes/${owner}/cv.pdf?token=t`,
              },
              error: null,
            }),
        }),
      },
    } as unknown as OwnerClient;
    const result = await operation(client, "resumes.get_download", { id: crypto.randomUUID() });
    assert(
      result.url ===
        `https://example.invalid/supabase/storage/v1/object/sign/resumes/${owner}/cv.pdf?token=t`,
      `Public download URL: ${JSON.stringify(result)}`,
    );
  } finally {
    Deno.env.delete("CRM_PUBLIC_SUPABASE_URL");
  }
});

Deno.test("An operation without an output contract fails closed instead of returning raw rows", async () => {
  const schemas = outputSchemas as Record<string, unknown>;
  const saved = schemas["tasks.get"];
  delete schemas["tasks.get"];
  try {
    const client = {
      rpc: () =>
        Promise.resolve({
          data: { id: crypto.randomUUID(), storage_path: "private" },
          error: null,
        }),
    } as unknown as OwnerClient;
    const result = await operation(client, "tasks.get", { task_id: crypto.randomUUID() });
    assert(
      (result.error as { code?: string })?.code === "TEMPORARY_FAILURE" &&
        !("storage_path" in result),
      `Raw row must not pass through: ${JSON.stringify(result)}`,
    );
  } finally {
    schemas["tasks.get"] = saved;
  }
});

Deno.test({
  name: "Stateless tool calls answer application/json in both protocol eras",
  ...options,
  fn: () =>
    withStub(async (stub) => {
      const bearer = await token(stub);
      const read = call("tasks.get", { task_id: crypto.randomUUID() });
      stub.operation = () =>
        Response.json({ error: { code: "NOT_FOUND", message: "x", retryable: false } });
      // 2025-era (no protocol header): a streamed reply can be cut silently; JSON fails visibly.
      for (const [label, value, headers] of [
        ["legacy tools/call", read, {}],
        [
          "legacy initialize",
          {
            jsonrpc: "2.0",
            id: 2,
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "t", version: "1" },
            },
          },
          {},
        ],
        ["legacy batch", [read, { ...ping, id: 3 }], {}],
        [
          "modern tools/call",
          {
            ...read,
            params: {
              ...read.params,
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          },
          {
            "MCP-Protocol-Version": "2026-07-28",
            "MCP-Method": "tools/call",
            "MCP-Name": "tasks.get",
          },
        ],
      ] as const) {
        const request = post(stub.resource, bearer, value);
        for (const [k, v] of Object.entries(headers)) request.headers.set(k, v);
        const response = await mcp(request);
        const type = response.headers.get("Content-Type") ?? "";
        const text = await response.text();
        assert(
          response.status === 200 && type.startsWith("application/json"),
          `${label}: expected JSON, got ${response.status} ${type}`,
        );
        const message = JSON.parse(text);
        assert(
          Array.isArray(message) ? message.length === 2 : message.result || message.error,
          `${label}: complete JSON-RPC reply`,
        );
      }
      const notification = await mcp(
        post(stub.resource, bearer, { jsonrpc: "2.0", method: "notifications/initialized" }),
      );
      assert(notification.status === 202, `Notification accepted: ${notification.status}`);
      await notification.body?.cancel();
    }),
});
