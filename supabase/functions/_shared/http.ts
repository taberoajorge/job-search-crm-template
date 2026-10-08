import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { outputSchemas } from "../../../packages/contracts/src/mcp/output.ts";
import { parseOperation } from "../../../packages/contracts/src/mcp/index.ts";

export function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
export function error(
  code: string,
  message: string,
  field?: string,
  retryable = ["TEMPORARY_FAILURE", "RATE_LIMITED"].includes(code),
) {
  return { error: { code, message, ...(field ? { field } : {}), retryable } };
}
export function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}
export function cors(req: Request): HeadersInit {
  const origin = req.headers.get("Origin");
  const allowed = (Deno.env.get("CRM_ALLOWED_ORIGINS") ?? "http://localhost:5173").split(",");
  if (origin && !allowed.includes(origin)) {
    throw json(error("FORBIDDEN", "Origin not allowed"), 403, { Vary: "Origin" });
  }
  return {
    ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    "Access-Control-Allow-Headers":
      "authorization,apikey,x-client-info,content-type,mcp-protocol-version,mcp-method,mcp-name,last-event-id",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Expose-Headers": "WWW-Authenticate,MCP-Protocol-Version,Retry-After",
  };
}
export async function body(req: Request): Promise<unknown> {
  // Count bytes during streaming: Content-Length alone cannot bound chunked requests.
  const reader = req.body?.getReader();
  if (!reader) {
    throw json(error("VALIDATION_ERROR", "Request body is required"), 400);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 1048576) {
      await reader.cancel();
      throw json(error("VALIDATION_ERROR", "Body exceeds 1 MiB"), 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw json(error("VALIDATION_ERROR", "Malformed JSON"), 400);
  }
}
const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function ownerClient(req: Request, mcp = false) {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) {
    throw json(error("UNAUTHENTICATED", "Bearer token required"), 401);
  }
  const url = env("SUPABASE_URL");
  // `||`, not `??`: jose skips the iss/aud comparison when the expected value is "".
  const issuer = Deno.env.get("CRM_JWT_ISSUER") || `${url}/auth/v1`;
  const audience = mcp
    ? Deno.env.get("MCP_RESOURCE_URL") || `${url}/functions/v1/mcp`
    : "authenticated";
  let keys = jwks.get(url);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`));
    jwks.set(url, keys);
  }
  try {
    // Asymmetric signing is a deployment prerequisite; no secret-key verification fallback.
    const { payload } = await jwtVerify(auth.slice(7), keys, {
      issuer,
      audience,
      algorithms: ["ES256", "RS256"],
      clockTolerance: 5,
    });
    if (payload.role !== "authenticated" || !payload.sub || (mcp && !payload.client_id))
      throw new Error("Not an owner session");
  } catch (e) {
    // A JWKS outage (network, timeout, non-200/invalid key set) is retryable, never a bad token.
    const code = (e as { code?: string }).code ?? "";
    if (
      e instanceof TypeError ||
      ["ERR_JWKS_TIMEOUT", "ERR_JWKS_INVALID", "ERR_JOSE_GENERIC"].includes(code)
    )
      throw json(error("TEMPORARY_FAILURE", "Token verification unavailable; retry shortly"), 503);
    throw json(error("UNAUTHENTICATED", "Invalid, expired or wrong-audience token"), 401);
  }
  const client = createClient(url, env("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: auth } },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  await authorize(client, mcp);
  return client;
}
export type OwnerClient = Awaited<ReturnType<typeof ownerClient>>;
// Security spec: signed CV downloads expire within five minutes.
const CV_URL_SECONDS = 300;
// Leading bytes per allowed CV type: the stored Content-Type is only what the uploader declared.
// ponytail: DOCX is checked as a ZIP container only; parse [Content_Types].xml if that ever matters.
const CV_MAGIC: Record<string, number[]> = {
  "application/pdf": [0x25, 0x50, 0x44, 0x46, 0x2d],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    0x50, 0x4b, 0x03, 0x04,
  ],
};
// One owner check and one rate-limit unit; MCP batches call it once per message.
export async function authorize(client: SupabaseClient, mcp: boolean) {
  const { data, error: failure } = await client.rpc("crm_authorize", {
    p_mcp: mcp,
  });
  if (failure) {
    throw json(error("TEMPORARY_FAILURE", "Authorization check unavailable"), 503);
  }
  if (data?.error) {
    if (data.error.code === "RATE_LIMITED") throw json(data, 429, { "Retry-After": "60" });
    throw json(data, data.error.code === "FORBIDDEN" ? 403 : 401);
  }
}
export async function operation(
  client: OwnerClient,
  name: string,
  input: unknown,
): Promise<Record<string, unknown>> {
  let validated: unknown;
  try {
    validated = parseOperation(name, input);
  } catch (e) {
    const issue = (e as { issues?: { path: PropertyKey[]; message: string }[] }).issues?.[0];
    return error(
      "VALIDATION_ERROR",
      issue?.message ?? "Unknown operation or invalid input",
      issue?.path.map(String).join("."),
    );
  }
  if (name === "resumes.finalize") {
    const metadata = validated as {
      storage_path: string;
      checksum: string;
      media_type: string;
    };
    const { data: file, error: failure } = await client.storage
      .from("resumes")
      .download(metadata.storage_path);
    if (failure || !file) {
      return error("NOT_FOUND", "Upload the file before finalizing", "storage_path");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const magic = CV_MAGIC[metadata.media_type] ?? [];
    if (
      file.size > 10485760 ||
      file.type !== metadata.media_type ||
      !magic.length ||
      magic.some((byte, i) => bytes[i] !== byte)
    ) {
      return error("VALIDATION_ERROR", "Resume media type/size mismatch", "media_type");
    }
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const checksum = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (checksum !== metadata.checksum) {
      return error("VALIDATION_ERROR", "Resume checksum mismatch", "checksum");
    }
  }
  const { data, error: failure } = await client.rpc("crm_operation", {
    p_operation: name,
    p_input: validated,
  });
  if (failure) {
    return error("TEMPORARY_FAILURE", "Operation unavailable; preserve your draft and retry");
  }
  if (name === "resumes.get_download" && data && !data.error) {
    const { data: signed, error: failure } = await client.storage
      .from("resumes")
      .createSignedUrl(data.storage_path, CV_URL_SECONDS);
    if (failure || !signed) {
      return error("TEMPORARY_FAILURE", "Resume download unavailable");
    }
    const publicBase = new URL(
      Deno.env.get("CRM_PUBLIC_SUPABASE_URL") ||
        Deno.env.get("CRM_JWT_ISSUER")?.replace(/\/auth\/v1$/, "") ||
        env("SUPABASE_URL"),
    );
    // Keep the public base's scheme, host, port and path prefix; move only the Storage path and token.
    const signedUrl = new URL(signed.signedUrl);
    const internalPrefix = new URL(env("SUPABASE_URL")).pathname.replace(/\/$/, "");
    const path = signedUrl.pathname.startsWith(internalPrefix)
      ? signedUrl.pathname.slice(internalPrefix.length)
      : signedUrl.pathname;
    const result = {
      url: `${publicBase.origin}${publicBase.pathname.replace(/\/$/, "")}${path}${signedUrl.search}`,
      expires_in: CV_URL_SECONDS,
      expires_at: new Date(Date.now() + CV_URL_SECONDS * 1000).toISOString(),
    };
    return outputSchemas[name]?.safeParse(result).success ? result : contractMismatch();
  }
  // Fail closed: every operation has an output contract, so a missing one never returns raw rows.
  const parsed = outputSchemas[name]?.safeParse(data);
  if (!parsed?.success) return contractMismatch();
  // Return the parsed contract output: it fills defaults that older stored rows lack and drops
  // undeclared columns, so the payload matches the published MCP outputSchema clients validate.
  return parsed.data as Record<string, unknown>;
}
// The RPC already ran (and may have committed): a blind replay returns the same receipt and fails
// the same check, so tell the caller to read current state instead of retrying.
function contractMismatch() {
  return error(
    "TEMPORARY_FAILURE",
    "Server result does not match the domain contract; a write may already be saved, so read current state before retrying",
    undefined,
    false,
  );
}
export async function safely(
  req: Request,
  handler: (headers: HeadersInit) => Promise<Response>,
): Promise<Response> {
  let headers: HeadersInit = {};
  try {
    headers = cors(req);
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }
    const response = await handler(headers);
    for (const [key, value] of Object.entries(headers)) {
      response.headers.set(key, String(value));
    }
    return response;
  } catch (e) {
    // Credential-free diagnostics: error class only, never request bodies or tokens.
    if (!(e instanceof Response)) console.error("edge", (e as Error)?.name ?? "Error");
    const response =
      e instanceof Response ? e : json(error("TEMPORARY_FAILURE", "Service unavailable"), 503);
    for (const [key, value] of Object.entries(headers)) {
      response.headers.set(key, String(value));
    }
    return response;
  }
}
