import {
  Server,
  createMcpHandler,
  isLegacyRequest,
  ProtocolError,
  specTypeSchemas,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import workflow from "./workflow.json" with { type: "json" };
import { toolCatalog } from "../../../packages/contracts/src/mcp/catalog.ts";
import { errorSchema } from "../../../packages/contracts/src/domain.ts";
import {
  authorize,
  body,
  env,
  json,
  operation,
  ownerClient,
  safely,
  type OwnerClient,
} from "../_shared/http.ts";
const tools = toolCatalog.map((tool) => {
  const checked = specTypeSchemas.Tool["~standard"].validate(tool);
  if (checked.issues) throw new Error("Invalid published tool schema");
  return checked.value;
});
function server(client: OwnerClient, modern: boolean) {
  const result = new Server(
    { name: "job-search-crm", version: "2.1.0" },
    {
      supportedProtocolVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"],
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
        ...(modern ? { extensions: { "io.modelcontextprotocol/skills": {} } } : {}),
      },
      instructions:
        "Owner-only CRM. Writes require idempotency keys; updates require versions. Outreach records delivery but never sends. Long operations return task IDs for tasks.get. Read skill://crm-workflow/SKILL.md through resources/read for the canonical method. A resource read does not activate a skill. Tool-only clients load .agents/skills/crm-workflow/SKILL.md from the repository. Research tools are supplied separately by Exa.",
    },
  );
  result.setRequestHandler("tools/list", async (request) => {
    if (request.params?.cursor !== undefined) throw new ProtocolError(-32602, "Unknown cursor");
    return { tools };
  });
  result.setRequestHandler("tools/call", async (request) => {
    const { name, arguments: input } = request.params;
    if (!toolCatalog.some((tool) => tool.name === name))
      throw new ProtocolError(-32602, "Unknown tool name");
    const value = await operation(client, name, input ?? {});
    return {
      content: [{ type: "text" as const, text: JSON.stringify(value) }],
      structuredContent: value,
      // Only a bare error envelope is a tool failure; tasks and outreach records carry their own `error`.
      isError: Object.keys(value).length === 1 && errorSchema.safeParse(value.error).success,
    };
  });
  result.setRequestHandler("resources/list", async (request) => {
    if (request.params?.cursor !== undefined) throw new ProtocolError(-32602, "Unknown cursor");
    return {
      resources: workflow.files.map(({ uri, name }) => ({ uri, name, mimeType: "text/markdown" })),
    };
  });
  result.setRequestHandler("resources/templates/list", async (request) => {
    if (request.params?.cursor !== undefined) throw new ProtocolError(-32602, "Unknown cursor");
    return { resourceTemplates: [] };
  });
  result.setRequestHandler("resources/read", async (request) => {
    // Exact allowlist lookup: never URL-normalize traversal or read filesystem/network paths.
    const file = workflow.files.find((file) => file.uri === request.params.uri);
    if (!file) throw new ProtocolError(-32602, "Unknown resource");
    return { contents: [{ uri: file.uri, mimeType: "text/markdown", text: file.text }] };
  });
  if (modern) {
    result.setRequestHandler(
      "skills/list",
      {
        params: z
          .object({ cursor: z.string().max(2048).optional() })
          .passthrough()
          .optional(),
      },
      async (params) => {
        if (params?.cursor !== undefined) throw new ProtocolError(-32602, "Unknown cursor");
        return {
          resultType: "complete",
          skills: [workflow.skill],
          ttlMs: 0,
          cacheScope: "private",
        };
      },
    );
    result.setRequestHandler(
      "skills/get",
      {
        params: z.object({ uri: z.string().max(2048) }).passthrough(),
      },
      async (params) => {
        if (params.uri !== workflow.skill.uri) throw new ProtocolError(-32602, "Unknown skill");
        return { resultType: "complete", skill: workflow.skill, ttlMs: 0, cacheScope: "private" };
      },
    );
  }
  return result;
}
function rpcError(id: unknown, code: number, message: string, status = 200) {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);
}
// One module-scope handler; each request's owner client travels with its own Request object.
const clients = new WeakMap<Request, OwnerClient>();
const transport = createMcpHandler(
  ({ era, requestInfo }) => server(clients.get(requestInfo!)!, era === "modern"),
  {
    legacy: "reject",
    responseMode: "json",
    maxSubscriptions: 0,
    // Credential-free diagnostics: error class and SDK code only, never bodies or tokens.
    onerror: (e) => console.error("mcp", e?.name ?? "Error", (e as { code?: unknown })?.code ?? ""),
  },
);
const resourceUrl = () =>
  Deno.env.get("MCP_RESOURCE_URL") || `${env("SUPABASE_URL")}/functions/v1/mcp`;
// 2025-era traffic. The SDK's stateless fallback always answers requests as SSE (its
// responseMode only covers 2026-07-28), and on a cold Edge worker a streamed reply can be
// cut after a logged 200, leaving the client to time out. A complete application/json body
// makes truncation a visible error and suits stateless workers.
async function legacyJson(req: Request, client: OwnerClient, msg: unknown) {
  const product = server(client, false);
  const http = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await product.connect(http);
  try {
    return await http.handleRequest(req, { parsedBody: msg });
  } finally {
    await http.close().catch(() => {});
    await product.close().catch(() => {});
  }
}
export function handler(req: Request): Promise<Response> {
  // Public protected-resource metadata: readable from any origin, ahead of the CRM Origin allowlist.
  if (
    req.method === "GET" &&
    new URL(req.url).pathname.includes(".well-known/oauth-protected-resource")
  ) {
    // A header-less copy carries no Origin, so the allowlist is skipped for this public document.
    return safely(new Request(req.url), () =>
      Promise.resolve(
        json(
          {
            resource: resourceUrl(),
            authorization_servers: [
              Deno.env.get("CRM_JWT_ISSUER") || `${env("SUPABASE_URL")}/auth/v1`,
            ],
            scopes_supported: ["openid"],
            bearer_methods_supported: ["header"],
            resource_name: "Personal job search CRM",
          },
          200,
          { "Access-Control-Allow-Origin": "*" },
        ),
      ),
    );
  }
  return safely(req, async () => {
    const resource = resourceUrl();
    if (req.method !== "POST") {
      return new Response(null, {
        status: 405,
        headers: { Allow: "POST,OPTIONS" },
      });
    }
    let client;
    try {
      client = await ownerClient(req, true);
    } catch (e) {
      if (e instanceof Response && e.status === 401) {
        // RFC 6750: name the failure only when a token was actually presented.
        e.headers.set(
          "WWW-Authenticate",
          `Bearer resource_metadata="${resource}/.well-known/oauth-protected-resource", scope="openid"${
            req.headers.has("Authorization") ? ', error="invalid_token"' : ""
          }`,
        );
      }
      throw e;
    }
    if (!req.headers.get("Content-Type")?.includes("application/json")) {
      return rpcError(null, -32600, "Content-Type must be application/json", 415);
    }
    const accept = req.headers.get("Accept") ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      return rpcError(
        null,
        -32600,
        "Accept must include application/json and text/event-stream",
        406,
      );
    }
    let msg: unknown;
    try {
      msg = await body(req);
    } catch (e) {
      if (e instanceof Response && e.status === 400) {
        return rpcError(null, -32700, "Parse error", 400);
      }
      if (e instanceof Response && e.status === 413) {
        return rpcError(null, -32000, "Request body exceeds 1 MiB", 413);
      }
      throw e;
    }
    if (Array.isArray(msg)) {
      // 2025-03-26 batches stay accepted, but every message spends its own rate-limit unit.
      if (msg.length > 100) return rpcError(null, -32600, "Batch exceeds 100 messages", 400);
      for (let i = 1; i < msg.length; i++) await authorize(client, true);
    }
    clients.set(req, client);
    // Gateway 520s leave no function error; note a request still running before the platform kills it.
    const method = Array.isArray(msg) ? "batch" : (msg as { method?: unknown })?.method;
    const slow = setTimeout(
      () => console.warn("mcp slow request", String(method).slice(0, 64)),
      15000,
    );
    try {
      const response = (await isLegacyRequest(req, msg))
        ? await legacyJson(req, client, msg)
        : await transport.fetch(req, { parsedBody: msg });
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    } finally {
      clearTimeout(slow);
    }
  });
}
if (import.meta.main) Deno.serve(handler);
