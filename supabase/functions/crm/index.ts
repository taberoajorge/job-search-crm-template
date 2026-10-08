import { body, error, json, operation, ownerClient, safely } from "../_shared/http.ts";
export function handler(req: Request) {
  return safely(req, async () => {
    if (req.method !== "POST") {
      return json(error("VALIDATION_ERROR", "Use POST"), 405, {
        Allow: "POST,OPTIONS",
      });
    }
    const client = await ownerClient(req);
    const input = (await body(req)) as { operation?: unknown; input?: unknown };
    if (
      !input ||
      typeof input !== "object" ||
      typeof input.operation !== "string" ||
      Object.keys(input).some((k) => !["operation", "input"].includes(k))
    ) {
      return json(error("VALIDATION_ERROR", "Expected operation and input"), 400);
    }
    return json(await operation(client, input.operation, input.input));
  });
}
if (import.meta.main) Deno.serve(handler);
